import http from 'node:http';
import path from 'node:path';
import {boot,readState,saveState} from './service-lib.mjs';
import {createDeliverer} from './outbox.mjs';
const rt=await boot(),{cfg,db,sql}=rt;
const filename=path.join(cfg.stateRoot,'delivery.json'),state=await readState(filename);await saveState(filename,state);
async function save(){await saveState(filename,state);}
const deliver=createDeliverer(rt,state,save);
let polling=false;
async function poll(){
 if(polling)return;polling=true;
 try{
  await rt.refresh();
  for(const kind of ['file','comment']){
   for(let offset=0;;offset+=100){
    const rows=kind==='file'
     ?await db.execute(sql(["SELECT a.id,a.issue_id,s.original_filename,s.byte_size,s.created_by_agent_id AS artifact_author,i.identifier,i.description,i.assignee_agent_id FROM issue_attachments a JOIN assets s ON s.id=a.asset_id AND s.company_id=a.company_id JOIN issues i ON i.id=a.issue_id AND i.company_id=a.company_id WHERE i.company_id=","::uuid AND a.created_at>=","::timestamptz AND s.created_by_agent_id IS NOT NULL ORDER BY a.created_at,a.id LIMIT 100 OFFSET ", ""],cfg.companyId,state.since,offset))
     :await db.execute(sql(["SELECT c.id,c.issue_id,c.body,c.author_agent_id,i.identifier,i.description,i.assignee_agent_id FROM issue_comments c JOIN issues i ON i.id=c.issue_id AND i.company_id=c.company_id WHERE i.company_id=","::uuid AND c.created_at>=","::timestamptz AND c.author_agent_id IS NOT NULL ORDER BY c.created_at,c.id LIMIT 100 OFFSET ", ""],cfg.companyId,state.since,offset));
    for(const row of rows){
     if(kind==='file'&&Number(row.byte_size)>50*1024*1024)continue;
     try{await deliver(row,kind);}catch{/* Missing/disabled/unverified origin fails closed. */}
    }
    if(rows.length<100)break;
   }
  }
 }catch{console.error('Delivery sweep failed; no credentials or customer content logged');}
 finally{polling=false;}
}
http.createServer(async(req,res)=>{
 const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 try{
  const url=new URL(req.url,'http://localhost');if(req.method!=='GET'||url.pathname!=='/status')return reply(404,{error:'Not found'});
  const id=url.searchParams.get('attachmentId');if(!/^[a-f0-9-]{36}$/.test(id||''))return reply(400,{error:'Valid attachmentId required'});
  const agent=await rt.authenticate(req.headers.authorization);
  const rows=await db.execute(sql(["SELECT s.created_by_agent_id FROM issue_attachments a JOIN assets s ON s.id=a.asset_id AND s.company_id=a.company_id WHERE a.id=","::uuid AND a.company_id=","::uuid"],id,cfg.companyId));
  if(rows[0]?.created_by_agent_id!==agent.id)return reply(403,{error:'Attachment not owned by this employee'});
  const r=state.records['file:'+id];reply(200,r?{status:r.status,slackFileId:r.fileId,slackUrl:r.slackUrl,error:r.error}:{status:'pending'});
 }catch{reply(403,{error:'Request could not be authenticated or verified'});}
}).listen(3192,'127.0.0.1');
setInterval(()=>void poll(),10000);void poll();
