import {createHash} from 'node:crypto';
import {slack,boundedBytes,safeText} from './service-lib.mjs';
function messageId(key){return createHash('sha256').update(key).digest('hex').slice(0,32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');}
export function createDeliverer(rt,state,save){return async function deliver(row,kind){
 const cfg=rt.cfg;
 const key=kind+':'+row.id;let record=state.records[key];
 if(['delivered','uncertain'].includes(record?.status)||record?.nextAttempt>Date.now())return;
 const author=kind==='file'?row.artifact_author:row.author_agent_id;
 const origin=await rt.origin(row,author),token=await rt.secret(rt.bot(origin.bot).ref);
 record??={issueId:row.issue_id,origin,attempts:0};state.records[key]=record;record.attempts++;record.status='working';await save();
 try{
  if(record.phase==='completing'){record.status='uncertain';record.error='Slack completion interrupted; verify before any resend';await save();return;}
  if(kind==='comment'){
   record.phase='completing';await save();
   const result=await slack(token,'chat.postMessage',{channel:origin.channel,...(origin.threadTs?{thread_ts:origin.threadTs}:{}),text:safeText(row.body),client_msg_id:messageId(key),unfurl_links:false,unfurl_media:false});
   record.slackMessageTs=result.ts;
  }else{
   if(!record.fileId){
    const result=await slack(token,'files.getUploadURLExternal',{filename:row.original_filename||'Generated file',length:Number(row.byte_size)});
    const url=new URL(result.upload_url);
    if(url.protocol!=='https:'||url.username||url.password||url.port||!(url.hostname==='files.slack.com'||url.hostname.endsWith('.slack.com')))throw new Error('Unsafe Slack upload URL');
    record.fileId=result.file_id;record.uploadUrl=url.href;record.phase='reserved';await save();
   }
   if(record.phase==='reserved'){
    const serviceToken=await rt.secret(cfg.paperclipApiKeyRef);
    const response=await fetch(rt.base+'/attachments/'+row.id+'/content',{headers:{Authorization:'Bearer '+serviceToken},redirect:'error',signal:AbortSignal.timeout(60000)});
    const bytes=await boundedBytes(response,50*1024*1024);if(bytes.length!==Number(row.byte_size))throw new Error('Attachment size mismatch');
    const uploaded=await fetch(record.uploadUrl,{method:'POST',body:bytes,redirect:'error',signal:AbortSignal.timeout(60000)});
    if(!uploaded.ok)throw new Error('Slack byte upload failed');record.phase='uploaded';delete record.uploadUrl;await save();
   }
   record.phase='completing';await save();
   const result=await slack(token,'files.completeUploadExternal',{files:[{id:record.fileId,title:row.original_filename||'Generated file'}],channel_id:origin.channel,...(origin.threadTs?{thread_ts:origin.threadTs}:{}),initial_comment:safeText(row.identifier||'Task')});
   record.slackUrl=result.files?.[0]?.permalink??null;
  }
  record.status='delivered';record.phase='complete';delete record.error;await save();
 }catch(e){
  record.status=record.phase==='completing'&&!e.definite?'uncertain':'retry';
  if(e.definite&&record.phase==='completing')record.phase=kind==='file'?'uploaded':undefined;
  record.error='Delivery failed; verify uncertain sends before retry';
  record.nextAttempt=Date.now()+Math.min(300000,15000*record.attempts);await save();
 }
}
}
