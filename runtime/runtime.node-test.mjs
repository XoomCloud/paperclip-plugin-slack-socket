import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseOrigin,safeText,readState,saveState,boundedBytes} from './service-lib.mjs';
import {normalizeManagedAiSessionConfig} from './session-config.mjs';
import {createDeliverer} from './outbox.mjs';

test('origin requires one exact marker and a verified DM for main scope',()=>{
 const good='XoomAI conversation: bot:U123:session:C123:100.1';
 assert.equal(parseOrigin(good)?.bot,'U123');
 assert.equal(parseOrigin(good+'\n'+good),null);
 assert.equal(parseOrigin('XoomAI conversation: bot:U123:session:C123:main'),null);
 assert.equal(parseOrigin('XoomAI conversation: bot:U123:session:D123:main')?.threadTs,undefined);
 assert.equal(parseOrigin('user says '+good),null);
});
test('normalizer preserves credential/model changes and does not mutate config',()=>{
 const config={managedAiConnection:'grant-1',model:'model-a',env:{HOME:'/tmp/paperclip-ai-11111111-1111-1111-1111-111111111111-ABC123',CODEX_HOME:'/tmp/paperclip-ai-11111111-1111-1111-1111-111111111111-ABC123/.codex',OTHER:'/different/path'}};
 const normalized=normalizeManagedAiSessionConfig(config);
 assert.equal(normalized.env.HOME,'<managed-ai-home>');
 assert.equal(normalized.env.CODEX_HOME,'<managed-ai-home>/.codex');
 assert.equal(normalized.env.OTHER,'/different/path');
 assert.equal(normalized.managedAiConnection,'grant-1');assert.equal(normalized.model,'model-a');
 assert.notEqual(config.env.HOME,normalized.env.HOME);
 assert.equal(normalizeManagedAiSessionConfig({env:{HOME:'/tmp/unknown'}}).env.HOME,'/tmp/unknown');
});
test('durable state survives recreation and corrupt state fails closed',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xoomai-state-test-'));const file=path.join(dir,'state.json');
 try{const state=await readState(file);state.records.one={status:'delivered'};await saveState(file,state);assert.equal((await readState(file)).records.one.status,'delivered');await fs.writeFile(file,'bad json');await assert.rejects(readState(file),/corrupt/);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('bounded downloads reject oversized content and Slack control text is escaped',async()=>{
 await assert.rejects(boundedBytes(new Response('0123456789'),5),/size limit/);
 assert.equal(safeText('<!channel> & message'),'&lt;!channel&gt; &amp; message');
 assert.match(safeText('xoxb-not-a-real-token'),/REDACTED/);
});
function fixture(overrides={}){
 const state={records:{}};let saves=0;
 const rt={cfg:{paperclipApiKeyRef:'test-only-service-ref'},origin:async()=>({bot:'U123',channel:'C123',threadTs:'100.1'}),secret:async()=>'test-only',bot:()=>({ref:'ref'}),base:'https://paperclip.invalid/api',...overrides};
 return {state,deliver:createDeliverer(rt,state,async()=>{saves++;}),saves:()=>saves};
}
const row={id:'attachment-1',issue_id:'issue-1',artifact_author:'agent-1',author_agent_id:'agent-1',byte_size:3,original_filename:'test.txt',body:'Completed',identifier:'TASK-1'};
test('outbox preserves reserved file identity across retry and never duplicates completion',async()=>{
 const old=globalThis.fetch;const calls=[];
 globalThis.fetch=async(url,options)=>{calls.push([String(url),options]);if(String(url).endsWith('files.getUploadURLExternal'))return Response.json({ok:true,file_id:'F123',upload_url:'https://files.slack.com/upload'});if(String(url).includes('/attachments/'))return new Response('abc');if(String(url).includes('/upload'))return new Response('ok');return Response.json({ok:true,files:[{permalink:'https://slack.invalid/file'}]});};
 try{const f=fixture();await f.deliver(row,'file');assert.equal(f.state.records['file:attachment-1'].status,'delivered');assert.equal(f.state.records['file:attachment-1'].fileId,'F123');const n=calls.length;await f.deliver(row,'file');assert.equal(calls.length,n);assert.equal(new URLSearchParams(calls.at(-1)[1].body).get('thread_ts'),'100.1');}finally{globalThis.fetch=old;}
});
test('unknown completion and post-crash completing records become uncertain without resending',async()=>{
 const old=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('network interrupted');};
 try{const f=fixture();await f.deliver(row,'comment');assert.equal(f.state.records['comment:attachment-1'].status,'uncertain');let invoked=false;globalThis.fetch=async()=>{invoked=true;throw new Error();};const g=fixture();g.state.records['comment:attachment-1']={phase:'completing',status:'working',attempts:1};await g.deliver(row,'comment');assert.equal(invoked,false);assert.equal(g.state.records['comment:attachment-1'].status,'uncertain');}finally{globalThis.fetch=old;}
});
test('definite Slack denial retries the same reserved upload, not a new file',async()=>{
 const old=globalThis.fetch;let reservations=0;
 globalThis.fetch=async url=>{if(String(url).endsWith('files.getUploadURLExternal')){reservations++;return Response.json({ok:true,file_id:'F123',upload_url:'https://files.slack.com/upload'});}if(String(url).includes('/attachments/'))return new Response('abc');if(String(url).includes('/upload'))return new Response('ok');return Response.json({ok:false,error:'ratelimited'});};
 try{const f=fixture();await f.deliver(row,'file');assert.equal(f.state.records['file:attachment-1'].status,'retry');f.state.records['file:attachment-1'].nextAttempt=0;await f.deliver(row,'file');assert.equal(reservations,1);assert.equal(f.state.records['file:attachment-1'].fileId,'F123');}finally{globalThis.fetch=old;}
});
test('unverified origin cannot send a reply or file',async()=>{
 const old=globalThis.fetch;let sent=false;globalThis.fetch=async()=>{sent=true;throw new Error();};
 try{const f=fixture({origin:async()=>{throw new Error('wrong employee');}});await assert.rejects(f.deliver(row,'file'),/wrong employee/);assert.equal(sent,false);}finally{globalThis.fetch=old;}
});
test('unsafe Slack upload destination is rejected before any bytes leave',async()=>{
 const old=globalThis.fetch;let download=false;globalThis.fetch=async url=>{if(String(url).endsWith('files.getUploadURLExternal'))return Response.json({ok:true,file_id:'F123',upload_url:'https://attacker.invalid/upload'});download=true;throw new Error();};
 try{const f=fixture();await f.deliver(row,'file');assert.equal(download,false);assert.equal(f.state.records['file:attachment-1'].status,'retry');}finally{globalThis.fetch=old;}
});
