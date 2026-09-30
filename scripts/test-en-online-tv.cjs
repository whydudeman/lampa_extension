const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(process.argv[2]||require('path').join(__dirname,'../plugin/en_online_tv.js'),'utf8').replace('version: VERSION,','version: VERSION, test: { resolveWith: resolveWith, startPlayer: startPlayer, providers: providers },');
const data={},played=[],notices=[];let cancel;
function Net(){this.clear=()=>{};this.timeout=()=>{}}
let c={window:{},Lampa:{Reguest:Net,Storage:{get:(k,d)=>k in data?data[k]:d,set:(k,v)=>data[k]=v},Loading:{start:fn=>cancel=fn,stop(){}},Noty:{show:x=>notices.push(x)},Player:{play:x=>played.push(x),playlist(){}},Listener:{follow(){}}}};vm.createContext(c);vm.runInContext(source,c);let t=c.window.EnOnlineTV.test;
assert(!c.window.EnOnline,'Original namespace must remain untouched');
let calls=[];let p={name:'retry',title:'Retry',site:'retry',hosts:['https://bad.example','https://good.example'],resolve:(ctx,ok,fail)=>{calls.push(ctx.host);if(ctx.host.includes('bad'))fail('bad');else ok([{url:'https://media.example/a.m3u8'}]);}};
t.resolveWith(p,{title:'Test',type:'movie'},{});assert.equal(calls.length,2);assert.equal(played.length,1);assert.equal(data.en_online_tv_hosts.retry.host,'https://good.example');
let delayed;p={name:'cancel',title:'Cancel',hosts:['https://example.org'],resolve:(ctx,ok)=>delayed=ok};t.resolveWith(p,{title:'Cancel',type:'movie'},{});cancel();delayed([{url:'https://example.org/video.m3u8'}]);assert.equal(played.length,1);
data.en_online_tv_media_proxy_url='https://relay.example';t.startPlayer('Test',{url:'https://media.example/master.m3u8',qualities:{'720p':'https://media.example/720.m3u8'},subtitles:[{label:'EN',url:'https://media.example/sub.vtt'}]});assert(played[1].url.startsWith('https://relay.example/https://'));assert(played[1].quality['720p'].startsWith('https://relay.example/'));assert(played[1].subtitles[0].url.startsWith('https://relay.example/'));
let vix=t.providers.find(p=>p.name==='vixsrc'),err;vix.resolve({host:'https://vixsrc.to',request:{type:'movie',tmdbId:550},withProxy:x=>x,network:{timeout(){},native:(u,ok)=>ok('<html>blocked</html>')}},()=>assert.fail('Malformed JSON accepted'),e=>err=e);assert.equal(err,'API returned invalid JSON');
console.log('PASS: namespace isolation, resolver failover, successful-host cache, cancellation, HLS/quality/subtitle proxy routing, malformed API response');
