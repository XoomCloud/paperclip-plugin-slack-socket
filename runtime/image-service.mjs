import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {boot,readState,saveState} from './service-lib.mjs';
const rt=await boot();
const {cfg}=rt,company=cfg.companyId,base=rt.base,model=cfg.images.model;
const statePath=path.join(cfg.stateRoot,'images.json'),state=await readState(statePath);
state.month??=new Date().toISOString().slice(0,7);state.spentUsd??=0;
let busy=false;
function reply(res,status,body){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}
async function generate(agentId,prompt){
  const key=(await rt.secret(cfg.images.secretRef)).trim();
  const month=new Date().toISOString().slice(0,7);
  if(month!==state.month){state.month=month;state.spentUsd=0;}
  const reserve=cfg.images.maxRequestCostUsd;
  if(!(reserve>0&&cfg.images.monthlyCapUsd>=reserve)||state.spentUsd+reserve>cfg.images.monthlyCapUsd)throw new Error('Image generation budget exhausted');
  state.spentUsd+=reserve;await saveState(statePath,state);
  const response=await fetch('https://openrouter.ai/api/v1/images',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(240000),
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','X-Title':'XoomAI Paperclip Images'},
    body:JSON.stringify({model,prompt,n:1,resolution:'1K'})
  });
  if(!response.ok){
    const reasons={401:'API key rejected',402:'OpenRouter credits required',403:'Model access denied',429:'OpenRouter rate limit reached'};
    throw new Error('Image generation failed: '+(reasons[response.status]||'OpenRouter HTTP '+response.status));
  }
  const result=await response.json();
  const cost=result.usage?.cost;
  if(typeof cost==='number'&&cost>=0){state.spentUsd+=cost-reserve;await saveState(statePath,state);}
  const image=result.data?.[0];
  if(typeof image?.b64_json!=='string'||image.b64_json.length>28*1024*1024)throw new Error('Image generation returned no image');
  const bytes=Buffer.from(image.b64_json,'base64');
  const signature=bytes.subarray(0,8).toString('hex');
  const mimeType=signature==='89504e470d0a1a0a'?'image/png':signature.startsWith('ffd8ff')?'image/jpeg':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;
  if(!mimeType || bytes.length>20*1024*1024)throw new Error('Image generation returned invalid image data');
  return {jobId:randomUUID(),provider:'openrouter',model,mimeType,imageBase64:bytes.toString('base64'),cost:result.usage?.cost??null};
}
http.createServer(async(req,res)=>{
  try{
    if(req.method!=='POST' || !['/generate','/check'].includes(req.url))return reply(res,404,{error:'Not found'});
    if(!req.headers.authorization?.startsWith('Bearer '))return reply(res,401,{error:'Employee authentication required'});
    await rt.refresh();
    const agent=await rt.authenticate(req.headers.authorization);
    if(!cfg.images.enabled)return reply(res,403,{error:'Image service disabled until operator approves budget'});
    if(req.url==='/check')return reply(res,200,{enabled:true,agentId:agent.id,provider:'openrouter',model});
    let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>12000)return reply(res,413,{error:'Prompt too large'});}
    const body=JSON.parse(text);
    if(typeof body.prompt!=='string' || !body.prompt.trim() || body.prompt.length>8000)return reply(res,400,{error:'Prompt must contain 1–8000 characters'});
    if(busy)return reply(res,429,{error:'Another image is being generated. Retry in one minute.'});
    busy=true;
    try{reply(res,200,await generate(agent.id,body.prompt));console.log(JSON.stringify({event:'image-generated',agentId:agent.id}));}
    finally{busy=false;}
  }catch(error){reply(res,500,{error:error.message?.startsWith('Native Codex')||error.message?.startsWith('Image generation')?error.message:'Image tool failed; inspect service diagnostics.'});console.error('Image service request failed; inspect redacted diagnostics');}
}).listen(3191,'127.0.0.1',()=>console.log('XoomAI image tool listening on loopback:3191'));
