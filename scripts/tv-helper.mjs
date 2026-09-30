import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const port = Number(process.env.LAMPA_TV_PORT || 8787);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginPath = process.env.LAMPA_TV_PLUGIN || path.join(root, 'plugin/en_online_tv.js');
const addresses = Object.values(os.networkInterfaces()).flat().filter(x => x.family === 'IPv4' && !x.internal).map(x=>x.address);
const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Private-Network':'true','Cache-Control':'no-store'};
let active = 0;
export function allowed(target) {
  return target.protocol === 'https:' && target.hostname === 'vixsrc.to' && !target.port && !target.username && !target.password && /^\/(?:api\/(?:movie\/\d+|tv\/\d+\/\d+\/\d+)|embed\/\d+)\/?$/.test(target.pathname);
}
export async function upstream(target) {
  if (!allowed(target)) throw new Error('Target not allowed');
  const response = await fetch(target, {redirect:'error', signal:AbortSignal.timeout(20000), headers:{'User-Agent':'Mozilla/5.0'}});
  const chunks=[];let size=0;
  for await (const chunk of response.body) { size+=chunk.length;if(size>2_000_000)throw new Error('Response too large');chunks.push(chunk); }
  return {status:response.status,body:Buffer.concat(chunks),type:response.headers.get('content-type')||'text/plain'};
}
const server = http.createServer(async(req,res)=>{
  const send=(status,body,type='text/plain; charset=utf-8')=>{res.writeHead(status,{...cors,'Content-Type':type});res.end(body);};
  if(req.method==='OPTIONS')return send(204,'');
  if(req.method!=='GET')return send(405,'GET only');
  if(req.url==='/health')return send(200,JSON.stringify({ok:true,service:'EN Online TV helper'}),'application/json');
  if(req.url?.split('?')[0]==='/en_online_tv.js'){
    try{
      // Local interface comes from the accepted connection, never the untrusted Host header.
      const local=req.socket.localAddress?.replace(/^::ffff:/,'');
      if(!local || local.includes(':'))return send(400,'Use the IPv4 installation address');
      const helper='http://'+local+':'+port;
      const setup='window.EnOnlineTVHelper='+JSON.stringify(helper)+';\n';
      return send(200,setup+fs.readFileSync(pluginPath,'utf8'),'application/javascript; charset=utf-8');
    }catch{return send(500,'Plugin file unavailable');}
  }
  if(req.url==='/')return send(200,'EN Online TV helper is running. Add /en_online_tv.js to Lampa extensions.');
  if(!req.url?.startsWith('/api/'))return send(404,'Not found');
  if(active>=6)return send(429,'Try again shortly');
  let target;
  try{target=new URL(req.url.slice(5));if(!allowed(target))return send(403,'Only VixSrc movie, episode and embed endpoints are allowed');}catch{return send(400,'Invalid target');}
  active++;
  try{const r=await upstream(target);send(r.status,r.body,r.type);}catch{send(502,'VixSrc request failed or timed out');}finally{active--;}
});
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))server.listen(port,'0.0.0.0',()=>{
 console.log('EN Online TV helper listening on port '+port);
 for(const ip of addresses)console.log('Install: http://'+ip+':'+port+'/en_online_tv.js');
});
export {server};
