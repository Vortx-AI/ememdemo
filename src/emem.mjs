// emem.mjs: the wire. Names, keys, signatures, writes, reads, and proof, against emem.dev.
import {blake3} from "https://cdn.jsdelivr.net/npm/@noble/hashes@1.8.0/blake3.js/+esm";

export const EMEM="https://emem.dev";
const WRITE=EMEM+"/a2a/tasks"; // /mcp refuses browser origins; /a2a runs the same tools and does not
export const NOTE=/^https:\/\/emem\.dev\/memories\/\S+\.md$/;
export const LINKS=/https:\/\/emem\.dev\/memories\/by_attester\/[a-z2-7]{8}\/[a-z2-7]{26}\.md/g;

// ---------- bytes ----------
export const U=s=>new TextEncoder().encode(s);
const A="abcdefghijklmnopqrstuvwxyz234567";
export const b32=u=>{let b=0,v=0,o="";for(const x of u){v=(v<<8)|x;b+=8;while(b>=5){o+=A[(v>>>(b-5))&31];b-=5}}if(b>0)o+=A[(v<<(5-b))&31];return o};
const cat=(...a)=>{const r=new Uint8Array(a.reduce((n,x)=>n+x.length,0));let i=0;for(const x of a){r.set(x,i);i+=x.length}return r};
export const cidOf=bytes=>b32(blake3(bytes).slice(0,16));
const b64=u=>btoa(String.fromCharCode(...new Uint8Array(u)));
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
export const tokens=n=>"~"+(n<4000?Math.max(1,Math.round(n/4)):Math.round(n/4000)+"k")+" tokens";
export const pool=async(items,n,fn)=>{let i=0;await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{while(i<items.length){const k=i++;await fn(items[k],k)}}))};
export const store=(k,v)=>{try{if(v===undefined)return JSON.parse(localStorage.getItem(k)||"null");localStorage.setItem(k,JSON.stringify(v))}catch{return null}};
export const net=async(url,init)=>{try{return await fetch(url,init)}catch{throw new Error(`Could not reach ${new URL(url).host}. Check your connection and try again.`)}};

// ---------- key: made in this browser, never sent anywhere ----------
let KEY=null;
export const key=async()=>{
 if(KEY)return KEY;
 const E={name:"Ed25519"},saved=store("emem.key");
 try{
  if(saved)KEY={priv:await crypto.subtle.importKey("pkcs8",unb64(saved.priv),E,false,["sign"]),pub:b32(unb64(saved.pub))};
  else{
   const k=await crypto.subtle.generateKey(E,true,["sign","verify"]);
   const priv=await crypto.subtle.exportKey("pkcs8",k.privateKey),pub=await crypto.subtle.exportKey("raw",k.publicKey);
   store("emem.key",{priv:b64(priv),pub:b64(pub)});
   KEY={priv:k.privateKey,pub:b32(new Uint8Array(pub))};
  }
 }catch{throw new Error("This browser cannot sign (no Ed25519). Update it and try again.")}
 return KEY;
};

// ---------- notes: named by the hash of their bytes, signed by the writer ----------
export const note=async(body,k)=>{
 const bytes=U(body),cid=cidOf(bytes),path=`/memories/by_attester/${k.pub.slice(0,8)}/${cid}.md`;
 const d=blake3(cat(U(`emem.memory_write.v2|create|${path}|`),blake3(bytes),U("|absent")));
 return{body,bytes,cid,path,url:EMEM+path,sig:b32(new Uint8Array(await crypto.subtle.sign("Ed25519",k.priv,d)))};
};

// emem.dev lets one key burst about 60 writes, then about 4 a second; stay under both
const bucket={left:40,at:Date.now()};
const slot=async()=>{for(;;){const now=Date.now();bucket.left=Math.min(40,bucket.left+(now-bucket.at)/1000*3.5);bucket.at=now;if(bucket.left>=1){bucket.left--;return}await new Promise(z=>setTimeout(z,(1-bucket.left)/3.5*1000+20))}};
export const put=async(n,pub)=>{
 for(let attempt=0;;attempt++){
  await slot();
  const x=await net(WRITE,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},
   body:JSON.stringify({skill:"emem_memory_create",args:{path:n.path,file_text:n.body,kind:"resource",attester:{pubkey_b32:pub,sig_b32:n.sig}}})});
  if(x.ok)return;
  if((x.status===429||x.status>=500)&&attempt<8){await new Promise(z=>setTimeout(z,1500*(attempt+1)));continue}
  const j=await x.json().catch(()=>({}));
  // same bytes, same name: if it is already there and hashes right, it is the same file
  const back=await fetch(n.url).catch(()=>null);
  if(back?.ok&&cidOf(new Uint8Array(await back.arrayBuffer()))===n.cid)return;
  throw new Error("emem.dev refused to store it: "+String(j.message||j.error||x.status).split("\n")[0].replace(/^a2a skill `\w+` failed: \(-?\d+\)\s*/,""));
 }
};

// read a note back and re-hash it: the name either matches the bytes or it does not
export const getNote=async url=>{
 const x=await net(url);if(!x.ok)throw new Error(`Nothing is stored at ${url} (${x.status}).`);
 const bytes=new Uint8Array(await x.arrayBuffer()),named=url.match(/([a-z2-7]{26})\.md$/)?.[1],cid=cidOf(bytes);
 return{url,cid,ok:named===cid,body:new TextDecoder().decode(bytes)};
};

// ---------- how another agent reads a result: plain HTTP, MCP, or A2A; and how anyone checks it ----------
const a2aCall=(skill,args)=>`curl -s ${EMEM}/a2a/tasks -H 'content-type: application/json' \\\n  -d '${JSON.stringify({skill,args})}'`;
const rehash=(url,cid)=>`# each file is named by the hash of its bytes; recompute it (pip install blake3):\ncurl -s ${url} | python3 -c "import sys,blake3,base64;print(base64.b32encode(blake3.blake3(sys.stdin.buffer.read()).digest(16)).decode().rstrip('=').lower())"\n# expect ${cid}`;
export const readVia=r=>r.token?r.via:{
 curl:`curl -s ${r.url}`+(r.first&&r.first!==r.url?`\ncurl -s ${r.first}`:""),
 mcp:`emem_memory_view {"file_cid":"${r.cid}"}`,
 a2a:a2aCall("emem_memory_view",{file_cid:r.cid}),
 verify:rehash(r.url,r.cid)};

// ---------- the token family: each row of emem.eio says what a token is and how it is read ----------
export const CID=/^[a-z2-7]{26}$/;
export const tokenType=(s,rows)=>{const m=s.match(/^emem:([a-z]+):\S+$/);return m&&rows[m[1]]?m[1]:null};
const fillPath=(p,token)=>p.replace("{token}",encodeURIComponent(token)).replace("{cid}",token.split(":").pop());
export const resolveToken=async(name,rows,tick=()=>{})=>{
 if(CID.test(name)){ // a bare file name: read it over A2A by its hash, the way another agent would
  tick("by name");
  const x=await net(EMEM+"/a2a/tasks",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({skill:"emem_memory_view",args:{file_cid:name}})});
  const j=await x.json().catch(()=>({}));if(!x.ok)throw new Error(`No file is named ${name} (${j.message||x.status}).`);
  const text=JSON.stringify(j,null,1);
  return{token:name,url:`${EMEM}/a2a/tasks`,cid:name,title:name,body:text.slice(0,20000),text,proof:"read by name over A2A",shape:"It is a file, read by its name.",
   via:{curl:a2aCall("emem_memory_view",{file_cid:name}),mcp:`emem_memory_view {"file_cid":"${name}"}`,a2a:a2aCall("emem_memory_view",{file_cid:name}),verify:"# the response carries the author's signature over the bytes; check it at https://emem.dev/verify"}};
 }
 const type=tokenType(name,rows),row=rows[type];if(!row)throw new Error(`${name.split(":").slice(0,2).join(":")} is not a token this page knows.`);
 tick(type);
 const url=EMEM+fillPath(row.path,name);
 const x=row.method==="GET"?await net(url):await net(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:name})});
 const j=await x.json().catch(()=>({}));if(!x.ok)throw new Error(`emem.dev could not resolve it: ${j.message||j.error||x.status}`);
 const text=JSON.stringify(j,null,1);
 const curl=row.method==="GET"?`curl -s ${url}`:`curl -s ${url} -H 'content-type: application/json' \\\n  -d '${JSON.stringify({token:name})}'`;
 return{token:name,url,cid:name.split(":").pop(),title:`emem:${type}`,body:text.slice(0,20000),text,proof:j.receipt?"signed by emem.dev":"resolved by emem.dev",shape:`It is an emem:${type} token: ${row.what}.`,
  via:{curl,mcp:`${row.tool} {"token":"${name}"}`,a2a:a2aCall(row.tool,{token:name}),verify:"# every response carries a receipt signed by emem.dev; check it offline at https://emem.dev/verify"}};
};

// ---------- gallery: what a card says, fetched and checked as the page loads ----------
export const summarize=async(s,rows)=>{
 if(NOTE.test(s.emem)){
  const n=await getNote(s.emem),secs=[...n.body.matchAll(/^- \[([^\]]+)\]\(/gm)].map(m=>m[1]);
  const lead=(n.body.match(/^> (.+)$/m)||[])[1]||"",text=n.body.replace(/^---\n[\s\S]*?\n---\n\n/,"");
  return{ok:n.ok,state:n.ok?"✓ matches its name":"✗ name does not match",nodes:secs.length
   ?[["stat",`${secs.length} sections · ${(lead.match(/~[\d.]+k? tokens/)||[""])[0]} · index ${tokens(n.body.length)}`],["peek",secs.slice(0,4).join("\n")]]
   :[["stat",tokens(text.length)],["peek",text.split("\n").filter(l=>l.trim()).slice(0,4).join("\n")]]};
 }
 const r=await resolveToken(s.emem,rows);
 return{ok:true,state:"✓ "+r.proof,nodes:[["stat",r.shape.replace(/^It is /,"")],["peek",r.body.slice(0,300)]]};
};
export const feed=async()=>null;
