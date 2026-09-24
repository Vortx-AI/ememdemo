// cache.mjs: emem is the cache. Everything emem serves by content address (a note named by the hash of its bytes, a bundle,
// a tree row) is immutable, so a browser that has read it once never needs to read it again; it re-hashes what it kept
// before trusting it, so a kept copy is exactly as good as a fresh one. What moves (the log head, inboxes, live cards) is
// read once per interval per browser, whatever the number of tabs, cards or agents asking, and the last good copy is shown,
// marked stale, when emem.dev is slow or down. The policy is declared in emem.eio ("cache …" lines), not here.
//
//   cache forever GET  <regex> [blake3]      content-addressed: kept in Cache Storage, re-hashed on every read if blake3
//   cache live <s> GET <regex>               moving: kept <s> seconds (+0–20% jitter so a crowd doesn't refresh in step)
//   cache live <s> POST <regex> [skill=a|b]  a read that happens to be a POST, keyed by its body
//
// Three more rules, for crowds: identical requests in flight are made once (coalesced); a 429 or 503 cools the whole host
// for its Retry-After (stale copies answer meanwhile); and live entries are shared between tabs over a BroadcastChannel.
const MAX_BODY=8e6,MAX_MEM=600,MAX_STORE=4000,STORE="emem-cache-v1",KEYHOST="https://cache.emem.invalid/";
let POLICY=[];
export const stats={hit:0,miss:0,shared:0,coalesced:0,stale:0,bypass:0};
const mem=new Map(),flight=new Map(),cool={},served=new Map();
export const setPolicy=lines=>{POLICY=lines.map(l=>{const t=l.trim().split(/\s+/),forever=t[0]==="forever",ttl=forever?Infinity:+t[1],[method,re,extra]=forever?t.slice(1):t.slice(2);
 return{forever,ttl,method:method.toUpperCase(),re:new RegExp(re),check:extra==="blake3"?"blake3":null,skills:extra?.startsWith("skill=")?extra.slice(6).split("|"):null}})};
const policyOf=(url,method,body)=>POLICY.find(p=>p.method===method&&p.re.test(url)&&(!p.skills||(()=>{try{return p.skills.includes(JSON.parse(body).skill)}catch{return false}})()));
const b3=()=>globalThis.ememCrypto?.blake3;
const A="abcdefghijklmnopqrstuvwxyz234567",b32=u=>{let b=0,v=0,o="";for(const x of u){v=(v<<8)|x;b+=8;while(b>=5){o+=A[(v>>>(b-5))&31];b-=5}}if(b>0)o+=A[(v<<(5-b))&31];return o};
// a note's name is the first 128 bits of the BLAKE3 of its bytes: a kept copy is used only while that still holds
const named=(url,buf)=>{const m=url.match(/([a-z2-7]{26})\.md$/),h=b3();return!m||!h||b32(h(new Uint8Array(buf)).slice(0,16))===m[1]};
const keyOf=(method,url,body)=>method==="GET"?`GET ${url}`:`${method} ${url} ${body||""}`;
const storeKey=k=>{const h=b3();return KEYHOST+(h?b32(h(new TextEncoder().encode(k))):encodeURIComponent(k).slice(0,1800))};
const trim=()=>{while(mem.size>MAX_MEM)mem.delete(mem.keys().next().value)};
const put=(k,e)=>{mem.delete(k);mem.set(k,e);trim()};
const respond=(e,how)=>{stats[how]++;served.set(e.url,{how,at:e.at});
 return new Response(e.body.slice(0),{status:e.status,headers:[...e.headers,["x-emem-cache",how],["x-emem-cached-at",new Date(e.at).toISOString()]]})};
// what the last answer for a URL was: "miss" (fresh from the network), "hit", "shared", "coalesced" or "stale" (and when)
export const servedAs=url=>served.get(url)||null;

// ---------- the persistent layer: Cache Storage, for content-addressed reads (and a last copy of live ones) ----------
const cs=()=>globalThis.caches?.open(STORE).catch(()=>null)||Promise.resolve(null);
const fromStore=async(k,p,url)=>{try{const c=await cs();const x=await c?.match(storeKey(k));if(!x)return null;const body=await x.arrayBuffer();
  if(p.check==="blake3"&&!named(url,body)){await c.delete(storeKey(k));return null} // a kept copy that no longer hashes to its name is dropped, never used
  return{url,status:x.status,headers:[["content-type",x.headers.get("content-type")||""]],body,at:+x.headers.get("x-at")||Date.now()}}catch{return null}};
let stored=0;
const toStore=async(k,e)=>{try{const c=await cs();if(!c)return;await c.put(storeKey(k),new Response(e.body.slice(0),{status:e.status,headers:{"content-type":e.headers[0]?.[1]||"","x-at":String(e.at)}}));
 if(++stored%200===0){const ks=await c.keys();if(ks.length>MAX_STORE)for(const r of ks.slice(0,ks.length-MAX_STORE))await c.delete(r)}}catch{}};
// the network wrote something: the page already holds the bytes, so the cache does too (no read-back through the network)
export const prime=(url,bytes,type="text/markdown")=>{const p=policyOf(url,"GET");if(!p)return;const body=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
 if(p.check==="blake3"&&!named(url,body))return;const e={url,status:200,headers:[["content-type",type]],body,at:Date.now(),until:Infinity};const k=keyOf("GET",url);put(k,e);toStore(k,e)};

// ---------- tabs share what moves ----------
const bc=typeof BroadcastChannel!=="undefined"?new BroadcastChannel("emem-cache"):null;
bc?.unref?.(); // (node: an open channel must not keep a process alive)
if(bc)bc.onmessage=({data})=>{if(data?.k&&data.e&&!(mem.get(data.k)?.at>=data.e.at))put(data.k,data.e)};

// the one entry point: net() hands every request here with the function that would fetch it
export const cached=async(url,init,go)=>{
 const method=(init.method||"GET").toUpperCase(),body=typeof init.body==="string"?init.body:undefined;
 const p=(init.cache==="no-store"||(init.body&&body===undefined))?null:policyOf(url,method,body);
 if(!p){stats.bypass++;return go()}
 const k=keyOf(method,url,body),now=Date.now(),e=mem.get(k);
 if(e&&(p.forever||e.until>now))return respond(e,"hit");
 if(p.forever){const s=await fromStore(k,p,url);if(s){put(k,{...s,until:Infinity});return respond(s,"hit")}}
 const host=new URL(url).host,old=e||(!p.forever?await fromStore(k,p,url):null);
 // a moving read kept by an earlier visit still answers while it is inside its interval (a reload costs nothing)
 if(!e&&old&&now-old.at<p.ttl*1000){put(k,{...old,until:old.at+p.ttl*1000});return respond(old,"hit")}
 if(cool[host]>now&&old)return respond(old,"stale");
 if(flight.has(k)){const f=await flight.get(k).catch(()=>null);if(f)return respond(f,"coalesced");return go()}
 let mine;
 const job=(async()=>{let x;
  try{x=await go()}catch(err){if(old){mine={stale:old};return old}throw err}
  if(x.status===429||x.status===503){const ra=Math.min(300,Math.max(5,+x.headers.get("retry-after")||30));cool[host]=Date.now()+ra*1000}
  if(!x.ok){mine={x};if(old&&x.status>=500){mine={stale:old};return old}return null}
  const len=+x.headers.get("content-length")||0;if(len>MAX_BODY){mine={x};return null}
  const buf=await x.clone().arrayBuffer();if(buf.byteLength>MAX_BODY||(p.check==="blake3"&&!named(url,buf))){mine={x};return null}
  const ent={url,status:x.status,headers:[["content-type",x.headers.get("content-type")||""]],body:buf,at:Date.now(),until:p.forever?Infinity:Date.now()+p.ttl*1000*(1+Math.random()*.2)};
  put(k,ent);if(p.forever)toStore(k,ent);else{bc?.postMessage({k,e:ent});toStore(k,ent)}
  mine={x};return ent})();
 flight.set(k,job);
 try{await job.catch(e=>{throw e})}finally{flight.delete(k)}
 if(mine?.stale)return respond(mine.stale,"stale");
 stats.miss++;served.set(url,{how:"miss",at:Date.now()});return mine.x;
};

// ---------- crowds of tabs: one live connection per browser ----------
// A stream (SSE) is opened by one tab only, chosen with the Web Locks API; it relays each event to the others over a
// BroadcastChannel. When that tab closes, its lock is released and the next tab takes over. No lock support: each tab
// opens its own. open(emit) starts the stream and returns a function that closes it.
export const sharedStream=(name,open,onData)=>{
 const ch=typeof BroadcastChannel!=="undefined"?new BroadcastChannel(`emem-stream-${name}`):null;
 if(ch)ch.onmessage=({data})=>onData(data);
 if(!globalThis.navigator?.locks||!ch){const close=open(onData);return()=>{close?.();ch?.close()}}
 const ac=new AbortController();
 navigator.locks.request(`emem-stream-${name}`,{signal:ac.signal},()=>new Promise(done=>{const close=open(d=>{onData(d);ch.postMessage(d)});ac.signal.addEventListener("abort",()=>{close?.();done()})})).catch(()=>{});
 return()=>{ac.abort();ch.close()};
};

// polling waits while nobody is looking: a hidden tab makes no requests
export const whenVisible=()=>typeof document==="undefined"||!document.hidden?Promise.resolve():new Promise(ok=>{const f=()=>{if(!document.hidden){document.removeEventListener("visibilitychange",f);ok()}};document.addEventListener("visibilitychange",f)});
// a poll interval for a crowd: never tighter than asked, spread by jitter so a thousand pages don't arrive together
export const every=(s,spread=.25)=>s*1000*(1+Math.random()*spread);
