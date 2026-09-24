// emem.mjs: the wire. Names, keys, signatures, writes, reads, and proof, against emem.dev.
// blake3 and ed25519 come from emem's own verifier, vendored in this repo and sealed with the site: no third-party crypto at runtime
import "./vendor/emem-verify-core.js";
const blake3=globalThis.ememCrypto.blake3;

export const EMEM="https://emem.dev";
const WRITE=EMEM+"/a2a/tasks"; // /mcp refuses browser origins; /a2a runs the same tools and does not
export const NOTE=/^https:\/\/emem\.dev\/memories\/\S+\.md$/;
export const LINKS=/https:\/\/emem\.dev\/memories\/by_attester\/[a-z2-7]{8}\/[a-z2-7]{26}\.md/g;

// ---------- bytes ----------
import {line as lineOf} from "./line.mjs";
export const U=s=>new TextEncoder().encode(s);
// specs: each note kind's schema, named by the hash of its text (set from emem.eio at boot); a note carries "spec: <cid>"
export const SPECS={};
export const specify=body=>{const k=(body.match(/^emem: ([\w.-]+)$/m)||[])[1];return k&&SPECS[k]&&!/^spec: /m.test(body)?body.replace(/^(emem: [\w.-]+)$/m,`$1\nspec: ${SPECS[k]}`):body};
const A="abcdefghijklmnopqrstuvwxyz234567";
export const b32=u=>{let b=0,v=0,o="";for(const x of u){v=(v<<8)|x;b+=8;while(b>=5){o+=A[(v>>>(b-5))&31];b-=5}}if(b>0)o+=A[(v<<(5-b))&31];return o};
const cat=(...a)=>{const r=new Uint8Array(a.reduce((n,x)=>n+x.length,0));let i=0;for(const x of a){r.set(x,i);i+=x.length}return r};
export const cidOf=bytes=>b32(blake3(bytes).slice(0,16));
const b64=u=>btoa(String.fromCharCode(...new Uint8Array(u)));
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
// tokens, estimated from what text is made of, not its length: fitted by least squares against the o200k tokenizer
// on 60 of this gallery's files and tested on the other 30 (median error 4.8%, 90th percentile 9.8%; length/4 gave 15.8% and 29.8%)
export const count=t=>Math.max(1,Math.round(1.098*(t.match(/[A-Za-z]+/g)||[]).length+2.207*(t.match(/\d+/g)||[]).length+.569*(t.match(/[^\w\s]/g)||[]).length+.325*(t.match(/\n/g)||[]).length));
export const tok=n=>"~"+(n<1000?Math.round(n):n<1e6?(n/1000).toFixed(n<10000?1:0)+"k":n<1e9?(n/1e6).toFixed(n<1e7?1:0)+"M":(n/1e9).toFixed(1)+"B");
export const tokens=t=>tok(count(t))+" tokens";
// what a model would spend to take in bytes it can't read as text: the same estimator over base64, about 0.63 tokens per byte
// (measured on random bytes and on this site's PNG sample). Text sources are counted as text instead.
export const RAW=0.634;
// the comparison a card or result states: what an agent reads (the note, or its line) against what the source would cost
export const tokenCompare=({note,line,srcTok,srcBytes})=>{const src=srcTok??(srcBytes?srcBytes*RAW:null),n=count(note);
 return{note:n,line:line?count(line):null,src,base64:srcTok==null&&!!srcBytes,x:src?Math.round(src/n):null}};
export const pool=async(items,n,fn)=>{let i=0;await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{while(i<items.length){const k=i++;await fn(items[k],k)}}))};
export const store=(k,v)=>{try{if(v===undefined)return JSON.parse(localStorage.getItem(k)||"null");localStorage.setItem(k,JSON.stringify(v))}catch{return null}};
// the run in hand: Stop aborts every request it still has open, and no write starts after it
export const RUN={ctl:null,req:0,bytes:0,wrote:[],at:0,cap:{requests:Infinity,bytes:Infinity,seconds:Infinity},why:""};
export const stopped=()=>{if(RUN.ctl?.signal.aborted)throw new Error(RUN.why||"Stopped. Nothing more was read or written.")};
// a run that reaches a cap stops itself like a Stop, and says which cap it was
const capped=()=>{if(!RUN.ctl||RUN.ctl.signal.aborted)return;const c=RUN.cap,s=(Date.now()-RUN.at)/1000;
 const hit=RUN.req>=c.requests?`${c.requests} requests`:RUN.bytes>=c.bytes?`${(c.bytes/1e9).toFixed(1)} GB declared`:s>=c.seconds?`${c.seconds} seconds`:"";
 if(hit){RUN.why=`Stopped: this run reached its budget of ${hit}. Nothing more was read or written.`;RUN.ctl.abort()}};
export const net=async(url,init={})=>{const signal=init.signal||RUN.ctl?.signal;if(!init.signal)capped();stopped();try{const x=await fetch(url,signal?{...init,signal}:init);if(RUN.ctl&&!init.signal){RUN.req++;if(init.method!=="HEAD")RUN.bytes+=+x.headers.get("content-length")||0}return x}catch(e){if(signal?.aborted)stopped();throw new Error(`Could not reach ${new URL(url).host}. Check your connection and try again.`)}};

// ---------- key: made in this browser, never sent anywhere ----------
// The working key is a non-extractable CryptoKey kept in IndexedDB: a script that runs here can sign with it but can't read it.
// A recovery file can only be made at setup (a new key, or one restored from a file), before the key is locked;
// after a reload the key is device-only. Old keys in localStorage are moved in once and the plain copy deleted.
let KEY=null,RECOVER=null;
const E={name:"Ed25519"};
const idb=(mode,fn)=>new Promise((ok,no)=>{let o;try{o=indexedDB.open("emem",1)}catch(e){return no(e)}o.onupgradeneeded=()=>o.result.createObjectStore("keys");o.onerror=()=>no(o.error);
 o.onsuccess=()=>{const t=o.result.transaction("keys",mode),r=fn(t.objectStore("keys"));t.oncomplete=()=>ok(r?.result);t.onerror=()=>no(t.error)}});
const lock=async(pkcs8,pubRaw)=>{const priv=await crypto.subtle.importKey("pkcs8",pkcs8,E,false,["sign"]),pub=b32(new Uint8Array(pubRaw));
 try{await idb("readwrite",st=>st.put({priv,pub},"site"))}catch{store("emem.key",{priv:b64(pkcs8),pub:b64(pubRaw)});return{priv,pub,stored:"local"}} // no IndexedDB (private mode): the old way, said so
 return{priv,pub,stored:"device"}};
export const keyState=()=>KEY?{stored:KEY.stored,recoverable:!!RECOVER}:null;
export const key=async()=>{
 if(KEY)return KEY;
 try{
  const saved=await idb("readonly",st=>st.get("site")).catch(()=>null);
  if(saved?.priv){KEY={priv:saved.priv,pub:saved.pub,stored:"device"};return KEY}
  const old=store("emem.key");
  if(old){RECOVER={priv:old.priv,pub:old.pub};KEY=await lock(unb64(old.priv),unb64(old.pub));if(KEY.stored==="device")try{localStorage.removeItem("emem.key")}catch{}return KEY}
  const k=await crypto.subtle.generateKey(E,true,["sign","verify"]);
  const priv=await crypto.subtle.exportKey("pkcs8",k.privateKey),pub=await crypto.subtle.exportKey("raw",k.publicKey);
  RECOVER={priv:b64(priv),pub:b64(pub)};KEY=await lock(priv,pub);
 }catch{throw new Error("This browser cannot sign (no Ed25519). Update it and try again.")}
 return KEY;
};

// ---------- private notes: AES-256-GCM with a key that travels only in the link's #fragment (never sent to a server) ----------
// The note's name is still the hash of what is stored (the ciphertext), so anyone can check integrity; only a holder of #k= can read it.
const b64u=u=>b64(u).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),unb64u=s=>unb64(s.replace(/-/g,"+").replace(/_/g,"/")+"===".slice((s.length+3)%4));
export const newSecret=()=>b64u(crypto.getRandomValues(new Uint8Array(32)));
const aes=s=>crypto.subtle.importKey("raw",unb64u(s),"AES-GCM",false,["encrypt","decrypt"]);
export const SEALED=/^---\nemem: sealed\.v1\n/;
export const sealText=async(body,secret)=>{const iv=crypto.getRandomValues(new Uint8Array(12)),c=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},await aes(secret),U(body)));
 return`---\nemem: sealed.v1\ncipher: AES-256-GCM\niv: ${b64u(iv)}\n---\n\n${b64u(c)}\n`};
export const openText=async(body,secret)=>{const iv=(body.match(/^iv: (\S+)$/m)||[])[1],c=body.replace(/^---\n[\s\S]*?\n---\n\n/,"").trim();
 try{return new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64u(iv)},await aes(secret),unb64u(c)))}catch{throw new Error("This note is encrypted, and the #k= in the link doesn't open it.")}};
// per-agent grants: a private link's key wrapped to one recipient's X25519 share key (ECDH with a fresh key, HKDF-SHA256,
// AES-GCM). The grant is an ordinary public note naming the recipient's share key; only that key's holder can unwrap it.
let SHARE=null;
export const shareKey=async()=>{if(SHARE)return SHARE;
 const saved=await idb("readonly",st=>st.get("share")).catch(()=>null);if(saved?.priv){SHARE=saved;return SHARE}
 const k=await crypto.subtle.generateKey({name:"X25519"},true,["deriveBits"]),priv=await crypto.subtle.importKey("pkcs8",await crypto.subtle.exportKey("pkcs8",k.privateKey),{name:"X25519"},false,["deriveBits"]);
 SHARE={priv,pub:b64u(new Uint8Array(await crypto.subtle.exportKey("raw",k.publicKey)))};await idb("readwrite",st=>st.put(SHARE,"share")).catch(()=>{});return SHARE};
const kek=async(shared,salt)=>crypto.subtle.deriveKey({name:"HKDF",hash:"SHA-256",salt,info:U("emem.grant.v1")},await crypto.subtle.importKey("raw",shared,"HKDF",false,["deriveKey"]),{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
export const grantBody=async(secret,forPub,of)=>{if(!/^[A-Za-z0-9_-]{43}$/.test(forPub))throw new Error(`"${forPub}" is not a share key (43 characters, base64url).`);
 const eph=await crypto.subtle.generateKey({name:"X25519"},true,["deriveBits"]),ephPub=new Uint8Array(await crypto.subtle.exportKey("raw",eph.publicKey)),rp=unb64u(forPub);
 const shared=await crypto.subtle.deriveBits({name:"X25519",public:await crypto.subtle.importKey("raw",rp,{name:"X25519"},false,[])},eph.privateKey,256);
 const iv=crypto.getRandomValues(new Uint8Array(12)),w=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},await kek(shared,new Uint8Array([...ephPub,...rp])),unb64u(secret)));
 return`---\nemem: grant.v1\nof: ${of}\nfor: ${forPub}\neph: ${b64u(ephPub)}\niv: ${b64u(iv)}\nwrapped: ${b64u(w)}\n---\n\n# a key to one private link, readable only by share key ${forPub.slice(0,8)}\n`};
export const openGrant=async body=>{const f=k=>(body.match(new RegExp(`^${k}: (\\S+)$`,"m"))||[])[1],me=await shareKey();
 if(f("for")!==me.pub)throw new Error("This grant is for another share key, not this browser's.");
 const ephPub=unb64u(f("eph")),shared=await crypto.subtle.deriveBits({name:"X25519",public:await crypto.subtle.importKey("raw",ephPub,{name:"X25519"},false,[])},me.priv,256);
 try{return{secret:b64u(new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64u(f("iv"))},await kek(shared,new Uint8Array([...ephPub,...unb64u(me.pub)])),unb64u(f("wrapped"))))),of:f("of")}}
 catch{throw new Error("This grant doesn't open with this browser's share key.")}};
export const SECRET_LINK=/^(https:\/\/emem\.dev\/memories\/\S+\.md)#k=([A-Za-z0-9_-]{43})$/;

// ---------- notes: named by the hash of their bytes, signed by the writer ----------
// a note may instead be addressed to another key (at = "arcade/<what>-<time>-to-<their 8>.md"); the signature covers that path
export const note=async(body,k,at)=>{
 const bytes=U(body),cid=cidOf(bytes),path=`/memories/by_attester/${k.pub.slice(0,8)}/${at||cid+".md"}`;
 const d=blake3(cat(U(`emem.memory_write.v2|create|${path}|`),blake3(bytes),U("|absent")));
 return{body,bytes,cid,path,url:EMEM+path,sig:b32(new Uint8Array(await crypto.subtle.sign("Ed25519",k.priv,d)))};
};

// emem.dev lets one key burst about 60 writes, then about 4 a second; stay under both
const bucket={left:40,at:Date.now()};
const slot=async()=>{for(;;){const now=Date.now();bucket.left=Math.min(40,bucket.left+(now-bucket.at)/1000*3.5);bucket.at=now;if(bucket.left>=1){bucket.left--;return}await new Promise(z=>setTimeout(z,(1-bucket.left)/3.5*1000+20))}};
const there=async n=>{const back=await fetch(n.url).catch(()=>null);return!!(back?.ok&&cidOf(new Uint8Array(await back.arrayBuffer()))===n.cid)};
const landed=n=>{if(RUN.ctl)RUN.wrote.push(n.url)};
// a key made in this page writes at most CAP notes an hour, counted in this browser: a swarm can still mint keys,
// which is why every result names its writer's tier (see who())
export const CAP=400;
const spend=()=>{const now=Date.now(),w=(store("emem.writes")||[]).filter(t=>now-t<3600e3);
 if(w.length>=CAP)throw new Error(`This browser's key has written ${CAP} notes in the last hour, the most this page allows. Try again in ${Math.ceil((w[0]+3600e3-now)/60e3)} minutes.`);
 w.push(now);store("emem.writes",w)};
// who wrote a note, and what a peer may conclude about that key (emem's enlistment ladder, GET /v1/enlist).
// Only what is computed here is claimed: a signed write with a full key is T1 (keyed); naming (T2) and affiliation (T4) need evidence this page doesn't hold.
export const who=(url,site)=>{const k=(String(url).match(/by_attester\/([a-z2-7]{8})\//)||[])[1];if(!k)return null;
 return{key:k,tier:"T1 keyed",site:k===site,says:k===site?"this site's key, pinned in its seal":"a key that signed its own namespace; not named, not affiliated"}};
export const put=async(n,pub)=>{
 for(let attempt=0;;attempt++){
  stopped();if(!attempt)spend();await slot();stopped();
  // a retry after a timeout or 5xx may follow a write that was accepted: look before writing again
  if(attempt&&await there(n)){landed(n);return}
  let x;try{x=await net(WRITE,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},
   body:JSON.stringify({skill:"emem_memory_create",args:{path:n.path,file_text:n.body,kind:"resource",attester:{pubkey_b32:pub,sig_b32:n.sig}}})})}
  catch(e){if(/^Stopped/.test(e.message)){if(await there(n))landed(n);throw e}if(attempt<4){await new Promise(z=>setTimeout(z,1500*(attempt+1)));continue}throw e}
  // a 200 can still carry a failed task: read it before calling the write done
  const ok=x.ok?await x.clone().json().then(j=>!(j?.error||/^(failed|error|rejected)$/i.test(j?.status||j?.state||j?.result?.status||"")||j?.result?.isError)).catch(()=>true):false;
  if(ok){landed(n);return}
  if((x.status===429||x.status>=500)&&attempt<8){await new Promise(z=>setTimeout(z,1500*(attempt+1)));continue}
  const j=await x.json().catch(()=>({}));
  // same bytes, same name: if it is already there and hashes right, it is the same file
  const back=await fetch(n.url).catch(()=>null);
  if(back?.ok&&cidOf(new Uint8Array(await back.arrayBuffer()))===n.cid){landed(n);return}
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
// every value in a copied command is data: single-quoted, with any quote inside it closed and escaped
export const shq=v=>`'${String(v).replace(/'/g,"'\\''")}'`;
const a2aCall=(skill,args)=>`curl -s ${EMEM}/a2a/tasks -H 'content-type: application/json' \\\n  -d ${shq(JSON.stringify({skill,args}))}`;
const rehash=(url,cid)=>`# each file is named by the first 128 bits of the BLAKE3 hash of its bytes: making different bytes with this name takes about 2^128 tries.
# an index lists every section by its name, so the index's own name commits to all of them (a hash tree).
# recompute it (pip install blake3):\ncurl -s ${url} | python3 -c "import sys,blake3,base64;print(base64.b32encode(blake3.blake3(sys.stdin.buffer.read()).digest(16)).decode().rstrip('=').lower())"\n# expect ${cid}`;
export const readVia=r=>r.token?r.via:{
 curl:`curl -s ${r.url}`+(r.first&&r.first!==r.url?`\ncurl -s ${r.first}`:""),
 mcp:`emem_memory_view {"file_cid":"${r.cid}"}`,
 a2a:a2aCall("emem_memory_view",{file_cid:r.cid}),
 verify:rehash(r.url,r.cid)};

// ---------- proof: emem's own verifier, vendored; the expected signer is pinned in emem.eio ----------
let VERIFY;
export const verifier=()=>VERIFY??=Promise.resolve().then(()=>{const v=globalThis.ememVerify;if(!v?.selfTest())throw new Error("the verifier failed its self-test; nothing is reported as checked");return v});
export const receiptOk=async(receipt,signer)=>{if(!receipt)return false;const v=(await verifier()).verifyReceipt(receipt);return v.ok&&v.signer_b32===signer};
const unhex=h=>Uint8Array.from(h.match(/../g)||[],x=>parseInt(x,16));
const b32full=u=>b32(u);
export const post=(url,body,headers={})=>net(url,{method:"POST",headers:{"content-type":"application/json",accept:"application/json",...headers},body:JSON.stringify(body)});
export const json=async x=>{const j=await x.json().catch(()=>({}));if(!x.ok)throw new Error(`emem.dev said ${x.status}: ${j.message||j.error||j.code||"no detail"}`);return j};
export const fmt=v=>{const n=Number(v);return v==null||v===""?"—":Number.isFinite(n)?(Math.abs(n)>=100?n.toFixed(1):String(+n.toPrecision(3))):String(v)};
export const day=t=>String(t||"").slice(0,10);
export const short=k=>k?k.slice(0,8)+"…":"";

// a raster artifact is a small grid of floats; its name is the hash of its bytes, and it draws as a picture
export const grid=async cid=>{
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
   lines:[["measured",day(src.captured_at)],["source",src.scheme],["recipe",f.derivation?.fn_key],["kind",j.provenance?.class],["confidence",f.confidence!=null?fmt(f.confidence):""],["place",j.cell]],
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
// view a file by its name over A2A and check it here: do the bytes match the name, and did the key it names sign that path?
const viewChecked=async cid=>{
 const task=await json(await post(`${EMEM}/a2a/tasks`,{skill:"emem_memory_view",args:{file_cid:cid}}));
 const n=task.artifacts?.[0]?.parts?.[0]?.data;if(!n?.content)throw new Error(`No file is named ${cid}.`);
 await verifier();const{blake3:b3,ed,b32decode,hex}=globalThis.ememVerifyInternals,bytes=U(n.content),full=b3(bytes);
 const same=b32full(full.slice(0,16))===cid&&(!n.authorship||hex(full)===n.authorship.body_hash_hex);
 let author=null;
 // emem accepts two signing formats (v1, and v2 which also binds the prior version); its authorship block always describes v1, so try both
 if(n.authorship?.sig_b32){try{const a=n.authorship,sig=b32decode(a.sig_b32),key=b32decode(a.attester_pubkey_b32);
  const v1=new Uint8Array([...U(`emem.memory_write|${a.verb}|${a.signed_path}|`),...full]),v2=new Uint8Array([...U(`emem.memory_write.v2|${a.verb}|${a.signed_path}|`),...full,...U("|absent")]);
  author=(ed.verify(sig,b3(v1),key)||ed.verify(sig,b3(v2),key))&&a.signed_path===n.path}catch{author=false}}
 return{n,same,author};
};
// a note at any path, with who wrote it proved offline: bytes re-hashed, and the author's signature over its path checked
export const signedNote=async url=>{const g=await getNote(url),{n,same,author}=await viewChecked(g.cid);
 return{url,body:g.body,cid:g.cid,key:n.attester_pubkey_b32,path:n.path,at:n.signed_at,ok:same&&author===true&&EMEM+n.path===url}};
// a link's drift chain, as a watcher recorded it (tools/drift.mjs): each entry's author must be the watcher's full key,
// and each must name the one before it. Returns what the chain says, or null when nobody is watching.
export const driftOf=async(url,watcher)=>{const cid8=(url.match(/([a-z2-7]{26})\.md$/)||[])[1]?.slice(0,8);if(!cid8||!watcher)return null;
 const listed=(await json(await net(`${EMEM}/memories/by_attester/${watcher.slice(0,8)}/arcade/?limit=5000`))).entries||[];
 const paths=listed.map(e=>e.path).filter(p=>p.includes(`/arcade/drift-${cid8}-`)).sort().slice(-30);if(!paths.length)return null;
 const es=await Promise.all(paths.map(p=>signedNote(EMEM+p).catch(()=>null)));
 const f=(b,k)=>(b.match(new RegExp(`^${k}: (.+)$`,"m"))||[])[1]||"";let linked=true,bad=0;
 es.forEach((e,i)=>{if(!e||!e.ok||e.key!==watcher||f(e.body,"of")!==url)bad++;else if(i&&f(e.body,"previous")!==es[i-1]?.url)linked=false});
 const good=es.filter(e=>e?.ok&&e.key===watcher),changed=good.filter(e=>/ changed \d+\/\d+$/m.test((e.body.match(/^# (.+)$/m)||[])[1]||""));
 return{n:good.length,bad,linked,since:f(good[0]?.body||"","at").slice(0,10),last:f(good.at(-1)?.body||"","at").slice(0,16).replace("T"," "),changed:changed.length,lastChange:f(changed.at(-1)?.body||"","at").slice(0,10)}};
// emem's corpus stream (GET /v1/stream): a signed corpus.state tick every 15 s. Each tick is verified here against the
// pinned key: ed25519 over blake3(PreimageV1 "emem.stream.tick.v1" {1 version, 2 key_epoch u32-BE, 3 served_at, 4 registry_cid, 5 distinct_cells u64-BE}).
export const corpusStream=(S,onTick)=>{if(typeof EventSource==="undefined")return null;const es=new EventSource(`${EMEM}/v1/stream?interval=15`);
 const pre=(domain,segs)=>{const o=[...U("emem.preimage.v1\0")],d=U(domain),u32=n=>o.push(n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255);u32(d.length);o.push(...d);for(const[t,b]of segs){o.push(t);u32(b.length);o.push(...b)}return new Uint8Array(o)};
 const be=(n,w)=>{const b=new Uint8Array(w);let v=BigInt(n);for(let i=w-1;i>=0;i--){b[i]=Number(v&255n);v>>=8n}return b};
 es.addEventListener("state",async m=>{try{const ev=JSON.parse(m.data);await verifier();const I=globalThis.ememVerifyInternals;
  const p=pre("emem.stream.tick.v1",[[1,U(String(ev.version))],[2,be(ev.responder.key_epoch,4)],[3,U(ev.served_at)],[4,U(ev.manifests.registry_cid)],[5,be(ev.corpus.distinct_cells,8)]]);
  const ok=ev.responder.pubkey_b32===S.signer&&I.ed.verify(I.b32decode(ev.signature.signature_b32),I.blake3(p),I.b32decode(S.signer));
  onTick({ok,cells:ev.corpus.distinct_cells,bands:ev.corpus.distinct_bands,facts:ev.corpus.facts_scanned,at:ev.served_at})}catch{onTick({ok:false})}});
 return es};
// a second reader: emem.dev fetches exactly these bytes itself and signs their hash (POST /v1/range_hash). The receipt is
// checked here: ed25519 over PreimageV1 "emem.range_hash.v1" {1 url, 2 u64-BE offset, 3 u64-BE length, 4 blake3 raw,
// 5 etag|"absent", 6 fetched_at, 7 responder key raw, 8 fetched_url}.
const pv1=(domain,segs)=>{const o=[...U("emem.preimage.v1\0")],d=U(domain),u32=n=>o.push(n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255);u32(d.length);o.push(...d);for(const[t,b]of segs){o.push(t);u32(b.length);o.push(...b)}return new Uint8Array(o)};
const be=(n,w)=>{const b=new Uint8Array(w);let v=BigInt(n);for(let i=w-1;i>=0;i--){b[i]=Number(v&255n);v>>=8n}return b};
export const rangeHash=async(url,offset,length,S)=>{const j=await json(await post(`${EMEM}/v1/range_hash`,{url,offset,length}));await verifier();const I=globalThis.ememVerifyInternals,r=j.receipt||{};
 let signed=false;try{signed=r.responder_pubkey_b32===S.signer&&I.ed.verify(I.b32decode(r.signature_b32),I.blake3(pv1("emem.range_hash.v1",[[1,U(j.url)],[2,be(j.offset,8)],[3,be(j.length,8)],[4,I.b32decode(j.blake3_b32)],[5,U(j.etag||"absent")],[6,U(j.fetched_at)],[7,I.b32decode(r.responder_pubkey_b32)],[8,U(j.fetched_url)]])),I.b32decode(S.signer))}catch{}
 return{hash:j.blake3_b32,signed,etag:j.etag,at:j.fetched_at}};
// one row of a note's Merkle table, proved to the note's root with log2(n) hashes (GET /v1/tree/{cid}): the leaf is computed
// here from the row itself (blake3(url ‖ u64-BE offset ‖ u64-BE length ‖ hash)), then walked up the served path
export const treeRow=async(cid,row,root)=>{const j=await json(await net(`${EMEM}/v1/tree/${cid}?row=${encodeURIComponent(row.label)}`));await verifier();const I=globalThis.ememVerifyInternals;
 const cat=(...a)=>{const r=new Uint8Array(a.reduce((n,x)=>n+x.length,0));let i=0;for(const x of a){r.set(x,i);i+=x.length}return r};
 let h=I.blake3(cat(U(row.url||""),be(row.offset,8),be(row.length,8),I.b32decode(row.hash)));const mine=b32(h)===j.leaf_b32;
 for(const p of j.path||[]){const x=I.b32decode(p.hash_b32);h=p.side==="left"?I.blake3(cat(x,h)):I.blake3(cat(h,x))}
 return{ok:mine&&b32(h)===root&&j.root_b32===root,steps:(j.path||[]).length,rows:j.rows,token:j.token}};
export const inboxOf=async k8=>(await json(await net(`${EMEM}/v1/inbox?to=${k8}&limit=500`))).messages||[];
const byName=async(cid,S,tick)=>{
 tick("by name over A2A");
 const{n,same,author}=await viewChecked(cid);
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
 const lp=env.live_perception,lpLine=lp?[["live perception",typeof lp==="string"?lp:[lp.summary||lp.label,lp.counts?JSON.stringify(lp.counts):"",lp.captured_at||lp.at].filter(Boolean).join(" · ").slice(0,220)||JSON.stringify(lp).slice(0,220)]]:[];
 const f={title:q,big:env.place_resolved.label,lines:[["answer",env.answer],...lpLine,...facts.map(x=>[x.band,`${fmt(x.value)} ${x.unit||""}`.trim()+`  ${x.token}`])],ok:signed,
  proof:[signed?`✓ answer signed by emem.dev`:"✗ answer signature fails",`${env.fact_cids.length} facts cited`,b?"evidence bundled":""]};
 const url=b?`${EMEM}/v1/memory_bundle/${handle}`:handle;
 return{token:handle,url,cid:handle.split(":").pop(),title:q,face:f,body:`${env.place_resolved.label}\n\n${env.answer}\n\nEvidence (each is a signed fact):\n${facts.map(x=>`- ${x.band} = ${fmt(x.value)} ${x.unit||""}  ${x.token}`).join("\n")}${b?`\n\nAll of it, one handle: ${handle}`:""}`,
  text:`${env.answer}\n${JSON.stringify(facts)}`,proof:f.proof.filter(Boolean).join(" · "),bad:!signed,
  shape:`It is an answer about ${env.place_resolved.label}, backed by ${env.fact_cids.length} signed facts`+(b?"; the bundle holds its evidence.":"."),
  via:{curl:(b?`# read this result: the evidence as it was bound, frozen by its handle\ncurl -s ${shq(url)}\n`:"")+`# get new evidence: asks again, and may answer differently\ncurl -s ${EMEM}/v1/ask -H 'content-type: application/json' -d ${shq(JSON.stringify({q}))}`,
   mcp:b?`emem_memory_token_resolve ${JSON.stringify({token:handle})}\n# new evidence (asks again): emem_ask ${JSON.stringify({q})}`:`emem_ask ${JSON.stringify({q})}`,a2a:b?a2aCallJs("emem_memory_token_resolve",{token:handle}):a2aCallJs("emem_ask",{q}),
   verify:`# the answer's receipt is signed by emem.dev (key ${short(S.signer)}); this page checked it with emem's own verifier`}};
};

// ---------- gallery: what a card says, fetched and checked as the page loads ----------
// a card, in verbs: what was done to this evidence, counted; nouns only where a number needs a unit
const sz=v=>v>=1e9?(v/1e9).toFixed(2)+" GB":v>=1e6?(v/1e6).toFixed(1)+" MB":(v/1e3).toFixed(1)+" KB";
export const summarize=async(s,S)=>{
 if(NOTE.test(s.emem)){
  const n=await getNote(s.emem),b=n.body,k=x=>(b.match(new RegExp(`^${x}: (.+)$`,"m"))||[])[1]||"",kind=k("emem"),st=/^after: sth /m.test(b)?"stamped":"";
  const state=n.ok?"✓ note":n.ok===false?"✗ name lies":"· unnamed",V=(...v)=>v.filter(Boolean).join(" · ");
  // tokens: the note an agent reads, against the source it names (text as text; binary as base64)
  const bytesSrc=+(b.match(/^bytes: (?:about )?(\d+)/m)||[])[1]||0,claimed=(b.match(/(~[\d.]+[kMB]?) tokens in \d+ sections/)||[])[1];
  const toTok=x=>x?+x.replace("~","").replace(/k$/,"e3").replace(/M$/,"e6").replace(/B$/,"e9"):null;
  const tc=tokenCompare({note:b,line:lineOf(b,s.emem),srcTok:toTok(claimed),srcBytes:kind==="pointer.v1"||kind==="directory.v1"?bytesSrc:0});
  const tline=["tok",`agent reads ${tok(tc.note)} tokens${tc.line?` (its line ${tok(tc.line)})`:""}${tc.src?` · source ${tok(tc.src)}${tc.base64?" as raw bytes":""} · ${tc.x.toLocaleString("en")}× less`:""}`];
  const out=(big,verbs,peek)=>({ok:n.ok!==false,state,tc,scope:n.ok?`checked ${new Date().toISOString().slice(11,19)}Z: this note's bytes hash to its name. The source it describes is re-read only when you open it.`:n.ok===false?"this note's bytes do not hash to its name":"this name makes no hash claim",line:lineOf(b,s.emem),nodes:[...(big?[["big",big]]:[]),tline,["verbs",verbs],...(peek?[["peek",peek]]:[])]});
  if(kind==="pointer.v1"){const m=b.match(/^bytes: (about )?(\d+)/m);return out(m?`${m[1]?"~":""}${sz(+m[2])}`:"at source",V(`hashed ${k("chunks").replace(/ hashed$/,"")}`,"rooted",k("place")?"placed":"",st),"")}
  if(kind==="directory.v1")return out(sz(+k("bytes")),V(`listed ${k("files")} files`,"publisher hashes kept","rooted",st));
  if(kind==="world.v1"){const f=(b.match(/ · emem:fact:/g)||[]).length;return out(`${f} facts`,V("sensed","cross-checked",/^## drift/m.test(b)?"drift measured":"",/echo-verified/.test(b)?"echo-verified":"","bundled",st))}
  if(kind==="camera.v1")return out(`${k("cameras")} cameras`,V(`re-hashed ${k("clips").split(" re-")[0]}`,`sun ${k("sun").split(" positions")[0]}`,st));
  if(kind==="compare.v1")return out(`${k("same")} identical`,V(`diffed`,`${k("changed")} differ`,`${k("only_a")}+${k("only_b")} unmatched`,st));
  if(kind==="timelapse.v1"){const d=[...b.matchAll(/^\| (\d{4})-\d\d-\d\d \|/gm)].map(m=>m[1]);return out(d.length?`${d[0]}–${d.at(-1)}`:"",V(`framed ${k("frames").split(" with")[0]}`,"3 cubes signed",k("rasterset")?"bound":"",st))}
  if(kind==="track.v1")return out(`${k("steps")} steps`,V(`checked ${k("verified")}`,"chained",st));
  const secs=[...b.matchAll(/^- \[([^\]]+)\]\(/gm)].length,text=b.replace(/^---\n[\s\S]*?\n---\n\n/,"");
  return out("",V(secs?`cut into ${secs} sections`:"",tokens(secs?text:text),/## Read as data/.test(b)?"injection flagged":"",st),secs?"":text.split("\n").filter(l=>l.trim()&&!/^[#>|-]/.test(l)).slice(0,2).join("\n"));
 }
 if(ASK.test(s.emem))return{ok:true,state:"live",nodes:[["verbs","asked live · answered signed · bundled"]]};
 const r=await resolveToken(s.emem,S),f=r.face;
 return{ok:!r.bad,state:r.bad?"✗ receipt":"✓ receipt",scope:`checked ${new Date().toISOString().slice(11,19)}Z: emem.dev's receipt for this token verifies against the pinned key. That says who signed it, not that the value is right.`,nodes:[...(/\d/.test(f.big||"")&&f.big.length<=24?[["big",f.big]]:[]),...(f.canvases?.length?[["canvas",f.canvases]]:[]),["verbs",r.proof.replace(/✓ /g,"").split(" · ").slice(0,3).join(" · ")]]};
};


// who else re-read a pointer's source: witness notes addressed to its author, each checked here for bytes and signature
export const witnesses=async(pointerUrl,cid)=>{
 const author=pointerUrl.split("/").at(-2),j=await json(await net(`${EMEM}/v1/inbox?to=${author}&limit=200`));
 const mine=(j.messages||[]).filter(m=>m.from!==author&&new RegExp(`: witness ${cid} (ok|changed) \\d+/\\d+$`).test(m.title||"")).slice(0,12);
 const seen=new Map();
 await pool(mine,4,async m=>{try{const{n,same,author:signed}=await viewChecked(m.file_cid);
  if(same&&signed&&n.content.includes(`pointer: ${pointerUrl}`)&&n.attester_pubkey_b32.startsWith(m.from))seen.set(m.from,{from:m.from,ok:/ ok \d/.test(m.title),at:m.signed_at,url:EMEM+m.path})}catch{}});
 return[...seen.values()];
};

// a raster's centre, in emem's own terms: the cell it falls in, and signed facts about that cell
export const placeFacts=async({lat,lng})=>{
 const l=await json(await net(`${EMEM}/v1/locate?lat=${lat}&lng=${lng}`)),cell=l.cell64||l.cell;
 const r=await json(await post(`${EMEM}/v1/recall`,{cell,bands:["copdem30m.elevation_mean","indices.ndvi","era5.t2m"]}));
 return[`centre cell ${cell} (emem:cell, about 10 m across)`,...(r.facts||[]).map(f=>`${f.band} ${fmt(f.value)}${f.unit?" "+f.unit:""}: ${f.memory_token}`)];
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

// emem-guard: every emem: citation in a text resolved and judged by emem.dev; a signed allow or deny with a reason code
export const guard=async(text,S)=>{
 const t=await json(await post(`${EMEM}/a2a/tasks`,{skill:"emem_guard_verdict",args:{texts:[text]}}));
 const d=t.artifacts?.[0]?.parts?.[0]?.data||{};
 return{action:d.action,code:d.code,fix:d.fix,reason:d.reason,checked:d.checked||0,signed:await receiptOk(d.receipt,S.signer)};
};

// the key, carried between browsers: a backup is the key itself, so whoever holds the file can write as you
// a recovery file exists only while this setup's copy is in memory (this session, before a reload)
export const exportKey=()=>RECOVER?JSON.stringify({emem_key:1,pub_b32:b32(unb64(RECOVER.pub)),...RECOVER},null,1):null;
export const importKey=async text=>{
 const j=JSON.parse(text);if(!j.priv||!j.pub)throw new Error("That file is not an emem key backup.");
 KEY=await lock(unb64(j.priv),unb64(j.pub));RECOVER={priv:j.priv,pub:j.pub};return KEY.pub;
};
