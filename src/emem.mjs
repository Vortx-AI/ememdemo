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

// read a note back and re-hash it: a hash-named file either matches its bytes or it does not; other names make no claim
export const getNote=async url=>{
 const x=await net(url);if(!x.ok)throw new Error(`Nothing is stored at ${url} (${x.status}).`);
 const bytes=new Uint8Array(await x.arrayBuffer()),named=url.match(/([a-z2-7]{26})\.md$/)?.[1],cid=cidOf(bytes);
 return{url,cid,ok:named?named===cid:null,body:new TextDecoder().decode(bytes)};
};

// ---------- how another agent reads a result: plain HTTP, MCP, or A2A; and how anyone checks it ----------
const a2aCall=(skill,args)=>`curl -s ${EMEM}/a2a/tasks -H 'content-type: application/json' \\\n  -d '${JSON.stringify({skill,args})}'`;
const rehash=(url,cid)=>`# each file is named by the hash of its bytes; recompute it (pip install blake3):\ncurl -s ${url} | python3 -c "import sys,blake3,base64;print(base64.b32encode(blake3.blake3(sys.stdin.buffer.read()).digest(16)).decode().rstrip('=').lower())"\n# expect ${cid}`;
export const readVia=r=>r.token?r.via:{
 curl:`curl -s ${r.url}`+(r.first&&r.first!==r.url?`\ncurl -s ${r.first}`:""),
 mcp:`emem_memory_view {"file_cid":"${r.cid}"}`,
 a2a:a2aCall("emem_memory_view",{file_cid:r.cid}),
 verify:rehash(r.url,r.cid)};

// ---------- proof: emem's own verifier, vendored; the expected signer is pinned in emem.eio ----------
let VERIFY;
const verifier=()=>VERIFY??=import("./vendor/emem-verify-core.js").then(()=>{const v=globalThis.ememVerify;if(!v?.selfTest())throw new Error("the verifier failed its self-test; nothing is reported as checked");return v});
const receiptOk=async(receipt,signer)=>{if(!receipt)return false;const v=(await verifier()).verifyReceipt(receipt);return v.ok&&v.signer_b32===signer};
const unhex=h=>Uint8Array.from(h.match(/../g)||[],x=>parseInt(x,16));
const b32full=u=>b32(u);
const post=(url,body,headers={})=>net(url,{method:"POST",headers:{"content-type":"application/json",accept:"application/json",...headers},body:JSON.stringify(body)});
const json=async x=>{const j=await x.json().catch(()=>({}));if(!x.ok)throw new Error(`emem.dev said ${x.status}: ${j.message||j.error||j.code||"no detail"}`);return j};
const fmt=v=>{const n=Number(v);return v==null||v===""?"—":Number.isFinite(n)?(Math.abs(n)>=100?n.toFixed(1):String(+n.toPrecision(3))):String(v)};
const day=t=>String(t||"").slice(0,10);
const short=k=>k?k.slice(0,8)+"…":"";

// a raster artifact is a small grid of floats; its name is the hash of its bytes, and it draws as a picture
const grid=async cid=>{
 const x=await net(`${EMEM}/v1/artifacts/${cid}`);if(!x.ok)return null;
 const buf=await x.arrayBuffer(),{blake3:b3}=globalThis.ememVerifyInternals||{};
 const ok=b3?b32full(b3(new Uint8Array(buf)))===cid:null,dv=new DataView(buf),w=dv.getUint32(8,true),hgt=dv.getUint32(12,true);
 const px=new Float32Array(buf.slice(64,64+4*w*hgt)),vals=[...px].filter(Number.isFinite).sort((a,b)=>a-b);
 const lo=vals[Math.floor(vals.length*.02)]??0,hi=vals[Math.floor(vals.length*.98)]??1;
 const cv=document.createElement("canvas");cv.width=w;cv.height=hgt;cv.className="grid";
 const g=cv.getContext("2d"),img=g.createImageData(w,hgt);
 px.forEach((v,i)=>{const t=Number.isFinite(v)?Math.max(0,Math.min(1,(v-lo)/(hi-lo||1))):0,c=Math.round(20+t*215);img.data.set([c*.62+30,c*.86+10,c*.78+18,255],i*4)});
 g.putImageData(img,0,0);return{ok,cv};
};

// each face turns a resolved record into what a person reads first, and says what was checked
const faces={
 async fact(j,S){
  const f=j.fact||{},src=f.sources?.[0]||{};
  const cbor=await net(`${EMEM}/v1/facts/${j.fact_cid}`,{headers:{accept:"application/cbor"}}).then(x=>x.ok?x.arrayBuffer():null).catch(()=>null);
  await verifier();const bytes=cbor&&b32full(globalThis.ememVerifyInternals.blake3(new Uint8Array(cbor)))===j.fact_cid;
  const signed=await receiptOk(j.receipt,S.signer)&&j.receipt.fact_cids?.includes(j.fact_cid);
  return{title:`${j.band} at ${j.cell}`,big:`${fmt(j.value_verbatim??j.value)} ${j.unit||""}`.trim(),
   lines:[["measured",day(src.captured_at)],["source",src.scheme],["recipe",f.derivation?.fn_key],["kind",j.provenance?.class],["place",j.cell]],
   ok:signed&&bytes!==false,proof:[signed?"✓ signed by emem.dev":"✗ signature does not check",bytes?"its bytes hash to its name":""]};
 },
 async bundle(j,S){
  const m=await post(`${EMEM}/v1/memory_token/resolve_many`,{tokens:j.citations.map(c=>c.memory_token)}).then(json).catch(()=>({items:[]}));
  const rows=j.citations.map((c,i)=>{const r=m.items?.[i]?.resolution||{};return[c.band,`${fmt(r.value_verbatim??r.value)} ${r.unit||""}`.trim()]});
  const signed=await receiptOk(j.receipt,S.signer);
  return{title:`${j.members} measurements, one handle`,big:`${j.members} readings`,lines:[...rows,["signed",day(j.signed_at)]],ok:signed,proof:[signed?"✓ signed by emem.dev":"✗ signature does not check"]};
 },
 async cell(j,S,id){
  const latest={};for(const f of j.facts||[])if(!latest[f.band]||f.tslot>latest[f.band].tslot)latest[f.band]=f;
  const signed=await receiptOk(j.receipt,S.signer);
  return{title:`the place ${id}`,big:`${Object.keys(latest).length} readings`,lines:Object.values(latest).map(f=>[f.band,`${fmt(f.value)} ${f.unit||""}`.trim()]),ok:signed,proof:[signed?"✓ signed by emem.dev":"✗ signature does not check"]};
 },
 async entity(j,S){
  const e=j.entity||{},[lng,lat]=e.geometry?.point||[];
  const signed=await receiptOk(j.receipt,S.signer);
  return{title:e.label,big:e.label,lines:[["kind",e.kind],["where",lat!=null?`${fmt(lat)}, ${fmt(lng)}`:""],["place",e.cell64],["named",day(j.minted_at)]],ok:signed,proof:[signed?"✓ signed by emem.dev":"✗ signature does not check"]};
 },
 async raster(j,S){
  const src=j.derivation?.sources?.[0]||{},gd=j.derivation?.artifact?.grid||{},signed=await receiptOk(j.receipt,S.signer),art=j.artifact?.present?await grid(j.artifact.artifact_cid):null;
  return{title:`${j.band} on ${day(src.captured_at)}`,big:`${gd.width}×${gd.height} px`,lines:[["scene",src.id],["cloud",src.cloud_cover!=null?fmt(src.cloud_cover)+"%":""],["pixel",gd.dx?`${gd.dx} m`:""],["spot check",j.spot_check?.passed?"passed":"not run"]],
   canvases:art?[art.cv]:[],ok:signed&&art?.ok!==false,proof:[signed?"✓ signed by emem.dev":"✗ signature does not check",art?.ok?"pixels hash to their name":""]};
 },
 async cube(j,S){
  const mem=j.derivation?.members||[],signed=await receiptOk(j.receipt,S.signer);
  await verifier();const arts=await Promise.all(mem.map(m=>grid(m.artifact_cid)));
  return{title:`${j.band} across ${mem.length} dates`,big:`${mem.length} dates`,lines:mem.map(m=>[day(m.captured_at),m.scene_id]),canvases:arts.filter(Boolean).map(a=>a.cv),
   ok:signed&&arts.every(a=>a?.ok!==false),proof:[signed?"✓ signed by emem.dev":"✗ signature does not check",arts.length&&arts.every(a=>a?.ok)?"pixels hash to their names":""]};
 },
 async rasterset(j,S){const signed=await receiptOk(j.receipt,S.signer);return{title:"a set of fields",big:`${(j.members||j.member_tokens||[]).length} fields`,lines:[],ok:signed,proof:[signed?"✓ signed by emem.dev":"✗ signature does not check"]}},
 async state(j){
  await verifier();const holds=b32full(globalThis.ememVerifyInternals.blake3(unhex(j.canonical_cbor_hex||"")))===j.cid,r=j.record||{},p=r.payload||{};
  return{title:`${r.kind}: ${p.q||""}`.trim(),big:r.kind,lines:[["place",p.place_resolved?.label],["question",p.q],["class",r.class],["built on",(r.derived_from||[]).map(d=>d.cid?.slice(0,10)).join(", ")||"nothing"]],
   ok:holds,proof:[holds?"✓ its bytes hash to its name":"✗ bytes do not match the name","(no signature: a state is only content-addressed)"]};
 }
};

const a2aCallJs=(skill,args)=>a2aCall(skill,args);
export const CID=/^[a-z2-7]{26}$/;
export const STH=/^https:\/\/emem\.dev\/v1\/log\/sth\/?$/;
export const ASK=/^ask:\s*(.{3,300})$/is;
export const tokenType=(s,rows)=>{const m=s.match(/^emem:([a-z]+):\S+$/);return m&&rows[m[1]]?m[1]:null};
const fillT=(t,token)=>t.replace(/\{token\}/g,token).replace(/\{id\}/g,token.replace(/^emem:[a-z]+:/,""));
const lines2text=(f)=>[f.title,f.big!==f.title?f.big:null,...f.lines.filter(([,v])=>v).map(([k,v])=>`${k}: ${v}`)].filter(Boolean).join("\n");

// any emem name resolves through one door: a token of the family, a bare file name, or the log head
export const resolveToken=async(name,S,tick=()=>{})=>{
 if(CID.test(name))return byName(name,S,tick);
 if(STH.test(name))return logHead(S,tick);
 const type=tokenType(name,S.tokens),row=S.tokens[type];if(!row)throw new Error(`${name.split(":").slice(0,2).join(":")} is not a token this page knows.`);
 tick(type);
 const url=EMEM+fillT(row.path,name),body=row.body?JSON.parse(fillT(row.body,name)):null;
 const j=await json(row.method==="GET"?await net(url):await post(url,body||{token:name}));
 const f=await faces[type](j,S,name.replace(/^emem:[a-z]+:/,""));
 const args=body||{token:name},text=JSON.stringify(j,null,1);
 const curl=row.method==="GET"?`curl -s ${url}`:`curl -s ${url} -H 'content-type: application/json' \\\n  -d '${JSON.stringify(args)}'`;
 return{token:name,url:row.method==="GET"?url:name,cid:name.split(":").pop(),title:f.title,face:f,
  body:`${lines2text(f)}\n\n${text.length>12000?text.slice(0,12000)+"\n…":text}`,text:lines2text(f)+"\n"+text,
  proof:f.proof.filter(Boolean).join(" · "),bad:!f.ok,shape:`It is an emem:${type} token: ${row.what}.`+(row.method==="POST"?` Resolve it with POST ${EMEM}${row.path}.`:""),
  via:{curl,mcp:row.tool==="-"?`# no MCP tool resolves emem:${type}; use the HTTP call in the curl tab`:`${row.tool} ${JSON.stringify(args)}`,
   a2a:row.tool==="-"?`# no A2A skill resolves emem:${type}; use the HTTP call in the curl tab`:a2aCallJs(row.tool,args),
   verify:type==="state"?`# a state has no signature; its name is blake3 of canonical_cbor_hex in the response`:`# the receipt is signed by emem.dev (key ${short(S.signer)}); this page checked it with emem's own verifier.\n# check it again server-side:\ncurl -s ${EMEM}/v1/verify_receipt -H 'content-type: application/json' -d '{"receipt": <the receipt field>}'`}};
};

// a file read by its name alone, over A2A, the way another agent would; bytes and authorship both checked here
const byName=async(cid,S,tick)=>{
 tick("by name over A2A");
 const task=await json(await post(`${EMEM}/a2a/tasks`,{skill:"emem_memory_view",args:{file_cid:cid}}));
 const n=task.artifacts?.[0]?.parts?.[0]?.data;if(!n?.content)throw new Error(`No file is named ${cid}.`);
 await verifier();const{blake3:b3,ed,b32decode,hex}=globalThis.ememVerifyInternals,bytes=U(n.content),full=b3(bytes);
 const same=b32full(full.slice(0,16))===cid&&(!n.authorship||hex(full)===n.authorship.body_hash_hex);
 let author=null;
 if(n.authorship?.sig_b32){try{const a=n.authorship,pre=new Uint8Array([...U(`emem.memory_write|${a.verb}|${a.signed_path}|`),...full]);author=ed.verify(b32decode(a.sig_b32),b3(pre),b32decode(a.attester_pubkey_b32))}catch{author=false}}
 const title=(n.content.match(/^#\s+(.+)$/m)||[])[1]||n.path.split("/").pop();
 const f={title,big:title,lines:[["written by",short(n.attester_pubkey_b32)],["kind",n.memory_kind],["signed",day(n.signed_at)],["path",n.path]],ok:same&&author!==false,
  proof:[same?"✓ bytes match the name":"✗ bytes do not match the name",author?`author ${short(n.attester_pubkey_b32)} signed it`:author===false?"✗ author signature fails":""]};
 const args={file_cid:cid};
 return{token:cid,url:EMEM+n.path,cid,title,face:f,body:`${lines2text(f)}\n\n${n.content}`,text:n.content,proof:f.proof.filter(Boolean).join(" · "),bad:!f.ok,
  shape:"It is a file, found by its name (the hash of its bytes).",
  via:{curl:`curl -s ${EMEM}${n.path}`,mcp:`emem_memory_view ${JSON.stringify(args)}`,a2a:a2aCallJs("emem_memory_view",args),verify:rehash(EMEM+n.path,cid)}};
};

// the transparency log head: the size of everything emem.dev has ever signed, itself signed
const logHead=async(S,tick)=>{
 tick("log head");
 const j=await json(await net(`${EMEM}/v1/log/sth`)),sth=j.sth||j;
 await verifier();const{blake3:b3,ed,b32decode}=globalThis.ememVerifyInternals;
 const preV1=(domain,segs)=>{const o=[...U("emem.preimage.v1\0")],d=U(domain),u32=n=>o.push(n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255);u32(d.length);o.push(...d);for(const[t,b]of segs){o.push(t);u32(b.length);o.push(...b)}return new Uint8Array(o)};
 const be=(n,len)=>{const o=[];let x=BigInt(n);for(let i=len-1;i>=0;i--)o.push(Number((x>>BigInt(8*i))&255n));return o};
 let ok=false;try{ok=ed.verify(b32decode(sth.signature_b32),b3(preV1("emem.translog.sth.v1",[[1,be(sth.tree_size,8)],[2,[...b32decode(sth.root_b32)]],[3,[...U(sth.signed_at)]],[4,[...b32decode(sth.responder_pubkey_b32)]]])),b32decode(sth.responder_pubkey_b32))&&sth.responder_pubkey_b32===S.signer}catch{}
 const f={title:"the transparency log head",big:Number(sth.tree_size).toLocaleString("en")+" entries",lines:[["signed",sth.signed_at],["root",short(sth.root_b32)],["key",short(sth.responder_pubkey_b32)]],ok,proof:[ok?"✓ log head signed by emem.dev":"✗ log head signature fails","pin it; the log may only grow"]};
 return{token:`${EMEM}/v1/log/sth`,url:`${EMEM}/v1/log/sth`,cid:short(sth.root_b32),title:f.title,face:f,body:`${lines2text(f)}\n\n${JSON.stringify(j,null,1)}`,text:JSON.stringify(j),proof:f.proof.join(" · "),bad:!ok,
  shape:"It is the signed head of emem.dev's append-only log. Keep it; a later head must prove it only grew.",
  via:{curl:`curl -s ${EMEM}/v1/log/sth\n# later: prove the log only grew since this head\ncurl -s "${EMEM}/v1/log/consistency?first=${sth.tree_size}"`,mcp:"emem_log_sth {}",a2a:a2aCallJs("emem_log_sth",{}),verify:"# the head's ed25519 signature was checked in this page against emem.dev's pinned key"}};
};

// a question about a place: streamed stages, a signed answer, and one handle for its evidence
export const ask=async(q,S,tick)=>{
 const x=await post(`${EMEM}/v1/ask`,{q},{accept:"text/event-stream"});if(!x.ok)await json(x);
 let env=null;const rd=x.body.getReader(),dec=new TextDecoder();let buf="";
 for(;;){const{done,value}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});let i;
  while((i=buf.indexOf("\n\n"))>=0){const frame=buf.slice(0,i);buf=buf.slice(i+2);const data=frame.split("\n").filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trim()).join("");if(!data)continue;
   let e;try{e=JSON.parse(data)}catch{continue}
   if(e.stage==="located")tick(e.detail?.place_resolved?.label||"located");else if(e.stage==="recalled")tick(`${(e.new_fact_cids||[]).length} facts`);else if(e.stage==="scored")tick("scored");else if(e.stage==="answer")env=e.detail}}
 if(!env)throw new Error("emem.dev did not finish the answer. Try again.");
 if(!env.place_resolved)throw new Error(env.answer||"That question does not name a place emem can find. Ask about a place, e.g. flood risk in Chennai.");
 const cell=env.place_resolved.cell64,pts=(env.spatial_trace?.layers||[]).flatMap(l=>l.points||[]).filter(p=>p.f!=null);
 const seen=new Set(),facts=pts.filter(p=>!seen.has(p.band)&&seen.add(p.band)).slice(0,12).map(p=>({band:p.band,value:p.value,unit:p.unit,token:`emem:fact:${cell}:${env.fact_cids[p.f]}`}));
 const signed=await receiptOk(env.receipt,S.signer);
 tick("one handle for the evidence");
 const b=await post(`${EMEM}/v1/memory_bundle`,{triples:facts.map(f=>({cell,band:f.band})),purpose:`evidence for: ${q}`}).then(json).catch(()=>null);
 const handle=b?.bundle_token||facts[0]?.token||"",score=(env.algorithm_outcomes_summary||[])[0];
 const f={title:q,big:env.place_resolved.label,lines:[["answer",env.answer],...facts.map(x=>[x.band,`${fmt(x.value)} ${x.unit||""}`.trim()+`  ${x.token}`])],ok:signed,
  proof:[signed?`✓ answer signed by emem.dev`:"✗ answer signature fails",`${env.fact_cids.length} facts cited`,b?"evidence bundled":""]};
 const url=b?`${EMEM}/v1/memory_bundle/${handle}`:handle;
 return{token:handle,url,cid:handle.split(":").pop(),title:q,face:f,body:`${env.place_resolved.label}\n\n${env.answer}\n\nEvidence (each is a signed fact):\n${facts.map(x=>`- ${x.band} = ${fmt(x.value)} ${x.unit||""}  ${x.token}`).join("\n")}${b?`\n\nAll of it, one handle: ${handle}`:""}`,
  text:`${env.answer}\n${JSON.stringify(facts)}`,proof:f.proof.filter(Boolean).join(" · "),bad:!signed,
  shape:`It is an answer about ${env.place_resolved.label}, backed by ${env.fact_cids.length} signed facts`+(b?"; the bundle holds its evidence.":"."),
  via:{curl:`curl -s ${EMEM}/v1/ask -H 'content-type: application/json' -d '${JSON.stringify({q})}'`+(b?`\ncurl -s ${url}`:""),mcp:`emem_ask ${JSON.stringify({q})}`,a2a:a2aCallJs("emem_ask",{q}),
   verify:`# the answer's receipt is signed by emem.dev (key ${short(S.signer)}); this page checked it with emem's own verifier`}};
};

// ---------- gallery: what a card says, fetched and checked as the page loads ----------
export const summarize=async(s,S)=>{
 if(NOTE.test(s.emem)){
  const n=await getNote(s.emem),secs=[...n.body.matchAll(/^- \[([^\]]+)\]\(/gm)].map(m=>m[1]);
  const lead=(n.body.match(/^> (.+)$/m)||[])[1]||"",text=n.body.replace(/^---\n[\s\S]*?\n---\n\n/,"");
  return{ok:n.ok!==false,state:n.ok?"✓ matches its name":n.ok===false?"✗ name does not match":"· not named by its hash",nodes:secs.length
   ?[["stat",`${secs.length} sections · ${(lead.match(/~[\d.]+k? tokens/)||[""])[0]} · index ${tokens(n.body.length)}`],["peek",secs.slice(0,4).join("\n")]]
   :[["stat",tokens(text.length)],["peek",text.split("\n").filter(l=>l.trim()).slice(0,4).join("\n")]]};
 }
 if(ASK.test(s.emem))return{ok:true,state:"live",nodes:[["stat","asks emem.dev now; the answer comes back signed"],["peek",s.note||""]]};
 const r=await resolveToken(s.emem,S),f=r.face;
 // a card's big line is for values ("915.1 m", "2 dates"); a name is already the card's title
 return{ok:!r.bad,state:r.proof.split(" · ")[0],nodes:[...(/\d/.test(f.big||"")&&f.big.length<=24?[["big",f.big]]:[]),...(f.canvases?.length?[["canvas",f.canvases]]:[]),["peek",f.lines.filter(([,v])=>v).slice(0,4).map(([k,v])=>`${k}: ${v}`).join("\n")]]};
};

// the public channel, live: every note any agent writes, as it is written
export const feed=async(render)=>{
 const rows=[],push=e=>{if(!e?.path||/\/arcade\/state\.md$/.test(e.path))return;rows.unshift(e);rows.length=Math.min(rows.length,6);render(rows)};
 const seed=await post(`${EMEM}/a2a/tasks`,{skill:"emem_memory_list_by_kind",args:{kind:"resource",limit:6}}).then(json).catch(()=>null);
 for(const f of (seed?.artifacts?.[0]?.parts?.[0]?.data?.files||[]).slice().reverse())push({path:f.path,file_cid:f.file_cid,attester_pubkey_b32:f.attester_pubkey_b32,signed_at:f.signed_at});
 const es=new EventSource(`${EMEM}/v1/memory/sse?path_prefix=/memories/by_attester/`);
 es.onmessage=m=>{try{const e=JSON.parse(m.data);if(e.type==="created")push(e)}catch{}};
 return es;
};
