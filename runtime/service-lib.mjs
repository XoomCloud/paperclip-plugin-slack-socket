import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
export function parseOrigin(description){
 const matches=[...description.matchAll(/^XoomAI conversation: (bot:(U[A-Z0-9]+):session:([CDG][A-Z0-9]+):(\d+\.\d+|main))$/gm)];
 if(matches.length!==1)return null;
 const m=matches[0];if(m[4]==='main'&&!m[3].startsWith('D'))return null;
 return {key:m[1],bot:m[2],channel:m[3],threadTs:m[4]==='main'?undefined:m[4]};
}
export function safeText(text){
 return String(text).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[REDACTED]')
 .replace(/\b(?:xox[baprs]-|xapp-|sk-(?:ant-)?)[A-Za-z0-9_-]+/g,'[REDACTED]')
 .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').slice(0,3200);
}
export async function readState(filename){
 try{return JSON.parse(await fs.readFile(filename,'utf8'));}
 catch(e){if(e.code!=='ENOENT')throw new Error('Runtime state corrupt; preserve and restore before continuing');return {since:new Date().toISOString(),records:{}};}
}
export async function saveState(filename,state){
 const temporary=filename+'.'+randomUUID()+'.tmp';
 const handle=await fs.open(temporary,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(state));await handle.sync();}finally{await handle.close();}
 await fs.rename(temporary,filename);
 // Directory fsync is supported on the Ubuntu target, unlike Windows.
 if(process.platform!=='win32'){const dir=await fs.open(path.dirname(filename),'r');try{await dir.sync();}finally{await dir.close();}}
}
export async function slack(token,method,body){
 const result=await fetch('https://slack.com/api/'+method,{method:'POST',redirect:'error',
 headers:{Authorization:'Bearer '+token,'Content-Type':'application/x-www-form-urlencoded'},
 body:new URLSearchParams(Object.entries(body).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):String(v)])),
 signal:AbortSignal.timeout(30000)});
 const value=await result.json();if(!result.ok||!value.ok){const e=new Error('Slack '+method+' rejected request');e.definite=result.ok&&value.ok===false;throw e;}return value;
}
export async function boundedBytes(response,max){
 if(!response.ok)throw new Error('Attachment download rejected');
 const chunks=[];let size=0;
 for await(const chunk of response.body){size+=chunk.length;if(size>max)throw new Error('Attachment exceeds size limit');chunks.push(chunk);}
 return Buffer.concat(chunks);
}
export async function boot(){
 const cfg=JSON.parse(await fs.readFile(process.env.XOOMAI_RUNTIME_CONFIG||'/etc/xoomai/runtime.json','utf8'));
 const require=createRequire(path.join(cfg.appRoot,'package.json'));
 const serverRoot=path.join(cfg.appRoot,'node_modules/@paperclipai/server');
 if(JSON.parse(await fs.readFile(path.join(serverRoot,'package.json'),'utf8')).version!=='2026.916.1')throw new Error('Unsupported Paperclip version');
 const {createDb}=await import(pathToFileURL(require.resolve('@paperclipai/db')).href);
 const {sql}=await import(pathToFileURL(require.resolve('drizzle-orm')).href);
 const {secretService}=await import(pathToFileURL(path.join(serverRoot,'dist/services/secrets.js')).href);
 const {buildAgentRegistry,resolveSlackBot}=await import(pathToFileURL(path.join(cfg.pluginRoot,'dist/agent-registry.js')).href);
 const db=createDb(process.env.DATABASE_URL),secrets=secretService(db);
 const secret=ref=>secrets.resolveSecretValue(cfg.companyId,typeof ref==='string'?ref:ref.secretId,'latest');
 const base=cfg.baseUrl.replace(/\/+$/,'')+'/api';
 let bots={},active=new Map();
 async function refresh(){
  const rows=await db.execute(sql(['SELECT id,name,title,status FROM agents WHERE company_id=','::uuid'],cfg.companyId));
  const selected=new Set(cfg.employees.filter(e=>e.enabled!==false).map(e=>e.agentId));
  const registry=buildAgentRegistry(rows.filter(a=>selected.has(a.id)).map(a=>({...a,urlKey:''})));
  const next={},nextActive=new Map(registry.agents.map(a=>[a.id,a]));
  for(const ref of cfg.slackBotTokenRefs){
   const identity=await slack(await secret(ref),'auth.test',{});
   if(identity.team_id!==cfg.slackTeamId)throw new Error('Slack workspace mismatch');
   const resolved=resolveSlackBot(registry,{userId:identity.user_id,username:identity.user,teamId:identity.team_id});
   if(resolved.status!=='resolved')throw new Error('Missing or ambiguous active employee for Slack bot');
   next[identity.user_id]={ref,agentId:resolved.agent.id};
  }
  bots=next;active=nextActive;
 }
 async function pluginState(key){
  const rows=await db.execute(sql(["SELECT s.value_json FROM plugin_state s JOIN plugins p ON p.id=s.plugin_id WHERE p.plugin_key='xoomai.slack-socket' AND s.scope_kind='instance' AND s.namespace='slack-socket' AND s.state_key=",''],key));
  if(rows.length!==1)return null;return rows[0].value_json;
 }
 async function origin(issue,author){
  const parsed=parseOrigin(issue.description||'');
  if(!parsed||!active.has(author)||issue.assignee_agent_id!==author||bots[parsed.bot]?.agentId!==author)throw new Error('No verified task origin for current employee');
  const session=await pluginState(parsed.key);
  if(!session||session.agentId!==author||session.channel!==parsed.channel||(parsed.threadTs&&session.threadTs!==parsed.threadTs))throw new Error('Conversation binding mismatch');
  if(cfg.privilegedBotPolicy?.botId===parsed.bot&&cfg.privilegedBotPolicy.channelId!==parsed.channel)throw new Error('Privileged origin channel denied');
  return parsed;
 }
 async function authenticate(authorization){
  if(!authorization?.startsWith('Bearer '))throw new Error('Authentication required');
  const r=await fetch(base+'/agents/me',{headers:{Authorization:authorization},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error('Invalid employee authentication');const agent=await r.json();
  if(agent.companyId!==cfg.companyId||!active.has(agent.id))throw new Error('Employee not active in this installation');
  return agent;
 }
 await refresh();
 return {cfg,db,sql,secret,base,origin,authenticate,refresh,bot:id=>bots[id]};
}
