// eio runtime: reads emem.eio, draws the page, runs its flows against emem.dev.
import {blake3} from "https://cdn.jsdelivr.net/npm/@noble/hashes@1.8.0/blake3.js/+esm";

const EMEM="https://emem.dev";
const PDFJS="https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
const PDFW="https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
const MAMMOTH="https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js";
const READER="https://r.jina.ai/";
const NOTE=/^https:\/\/emem\.dev\/memories\/\S+$/;
const TOKEN=/^emem:fact:\S+$/;

// ---------- language ----------
const parse=src=>{
 const st=[],lines=src.split("\n");
 for(let i=0;i<lines.length;i++){
  const l=lines[i].replace(/\s+$/,"");
  if(!l||l.startsWith("#"))continue;
  const m=l.match(/^(\w+)\s*(.*)$/);if(!m)throw new Error(`emem.eio:${i+1}: cannot read "${l}"`);
  let [,verb,rest]=m;
  if(rest==="<<"){const b=[];while(++i<lines.length&&lines[i].trim()!==">>")b.push(lines[i]);rest=b.join("\n")}
  st.push([verb,rest]);
 }
 const one=v=>st.find(s=>s[0]===v)?.[1]??"",all=v=>st.filter(s=>s[0]===v).map(s=>s[1]);
 const cols=s=>s.split(/\s{2,}/);
 return{one,all,cols,steps:v=>one(v).split(/\s*->\s*/).filter(Boolean)};
};
const fill=(t,x,enc)=>t.replace(/\{(\w+)\}/g,(_,k)=>{const v=String(x[k]??"");return enc?encodeURIComponent(v):v});

// ---------- bytes ----------
const U=s=>new TextEncoder().encode(s);
const A="abcdefghijklmnopqrstuvwxyz234567";
const b32=u=>{let b=0,v=0,o="";for(const x of u){v=(v<<8)|x;b+=8;while(b>=5){o+=A[(v>>>(b-5))&31];b-=5}}if(b>0)o+=A[(v<<(5-b))&31];return o};
const cat=(...a)=>{const r=new Uint8Array(a.reduce((n,x)=>n+x.length,0));let i=0;for(const x of a){r.set(x,i);i+=x.length}return r};
const cidOf=bytes=>b32(blake3(bytes).slice(0,16));
const b64=u=>btoa(String.fromCharCode(...new Uint8Array(u)));
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const sha256=async u=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",u))].map(x=>x.toString(16).padStart(2,"0")).join("");

// ---------- key: generated here, never leaves this browser ----------
let KEY=null;
const key=async()=>{
 if(KEY)return KEY;
 const E={name:"Ed25519"};let saved=null;
 try{saved=JSON.parse(localStorage.getItem("emem.key")||"null")}catch{}
 try{
  if(saved)KEY={priv:await crypto.subtle.importKey("pkcs8",unb64(saved.priv),E,false,["sign"]),pub:b32(unb64(saved.pub))};
  else{
   const k=await crypto.subtle.generateKey(E,true,["sign","verify"]);
   const priv=await crypto.subtle.exportKey("pkcs8",k.privateKey),pub=await crypto.subtle.exportKey("raw",k.publicKey);
   try{localStorage.setItem("emem.key",JSON.stringify({priv:b64(priv),pub:b64(pub)}))}catch{}
   KEY={priv:k.privateKey,pub:b32(new Uint8Array(pub))};
  }
 }catch{throw new Error("This browser cannot sign (no Ed25519). Update it and retry.")}
 return KEY;
};

// ---------- extraction ----------
const ext=n=>(n.match(/\.([a-z0-9]+)$/i)?.[1]||"").toLowerCase();
const pdfText=async buf=>{
 const pdf=await import(PDFJS);
 if(!pdf.GlobalWorkerOptions.workerPort)pdf.GlobalWorkerOptions.workerPort=new Worker(URL.createObjectURL(new Blob([`import "${PDFW}";`],{type:"text/javascript"})),{type:"module"});
 const doc=await pdf.getDocument({data:buf}).promise,out=[];
 for(let p=1;p<=doc.numPages;p++){const c=await(await doc.getPage(p)).getTextContent();out.push(c.items.map(i=>i.str+(i.hasEOL?"\n":"")).join(""))}
 return out.join("\n\n");
};
const script=src=>new Promise((ok,no)=>{const s=document.createElement("script");s.src=src;s.onload=ok;s.onerror=()=>no(new Error("could not load "+src));document.head.append(s)});
const docxText=async buf=>{if(!window.mammoth)await script(MAMMOTH);return(await window.mammoth.extractRawText({arrayBuffer:buf})).value};
const htmlText=s=>new DOMParser().parseFromString(s,"text/html").body?.innerText||"";
const clean=s=>s.replace(/\r\n?/g,"\n").replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim()+"\n";

// ---------- flows: each step takes the run and returns it ----------
const ops={
 async take(r){
  if(r.file){r.name=r.file.name;r.buf=await r.file.arrayBuffer();r.sha=await sha256(r.buf)}
  else if(/^https?:\/\/\S+$/.test(r.input)){r.name=r.input;r.remote=r.input}
  else{r.name=""}
  return r;
 },
 async text(r){
  let t;
  if(r.file){
   const e=ext(r.name);
   if(!r.spec.accept.includes(e))throw new Error(`.${e||"?"} is not supported. Try: ${r.spec.accept.join(" ")}`);
   t=e==="pdf"?await pdfText(r.buf):e==="docx"?await docxText(r.buf):new TextDecoder().decode(r.buf);
   if(e==="html"||e==="htm")t=htmlText(t);
   if(e==="pdf"&&!t.trim())throw new Error("This PDF has no text layer (a scan). OCR is not done here.");
  }else if(r.remote){
   const res=await fetch(READER+r.remote);if(!res.ok)throw new Error(`could not read that link (${res.status})`);
   t=await res.text();
  }else t=r.input;
  t=clean(t);
  if(!t.trim())throw new Error("Nothing to keep: no text found.");
  const head=r.name?`---\nsource: ${r.name.replace(/\n/g," ")}\n${r.sha?`sha256: ${r.sha}\n`:""}---\n\n`:"";
  r.text=t;r.body=head+t;r.bytes=U(r.body);
  if(r.bytes.length>r.spec.limit)throw new Error(`Too large: ${(r.bytes.length/1e6).toFixed(1)} MB. Limit ${(r.spec.limit/1e6).toFixed(0)} MB of text.`);
  return r;
 },
 async sign(r){
  const k=await key();
  r.cid=cidOf(r.bytes);r.key=k.pub;
  r.path=`/memories/by_attester/${k.pub.slice(0,8)}/${r.cid}.md`;
  const d=blake3(cat(U(`emem.memory_write.v2|create|${r.path}|`),blake3(r.bytes),U("|absent")));
  r.sig=b32(new Uint8Array(await crypto.subtle.sign("Ed25519",k.priv,d)));
  return r;
 },
 async put(r){
  const res=await fetch(EMEM+"/mcp",{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},
   body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"emem_memory_create",arguments:{path:r.path,file_text:r.body,kind:"resource",attester:{pubkey_b32:r.key,sig_b32:r.sig}}}})});
  const j=await res.json().catch(()=>({}));
  const msg=j.error?.message||(j.result?.isError||/^tool error/.test(j.result?.content?.[0]?.text||"")?j.result.content[0].text:"");
  if(!res.ok||msg){
   // same bytes, same name: if it is already there and still hashes right, reuse it
   const back=await fetch(EMEM+r.path).catch(()=>null);
   if(back?.ok&&cidOf(new Uint8Array(await back.arrayBuffer()))===r.cid){r.reused=true;return r}
   throw new Error((msg||`emem said ${res.status}`).split("\n")[0].replace(/^tool error \(-?\d+\):\s*/,""));
  }
  return r;
 },
 async link(r){r.url=EMEM+r.path;return r},
 async fetch(r){
  r.url=r.input;r.path=new URL(r.url).pathname;
  const res=await fetch(r.url);if(!res.ok)throw new Error(`emem has nothing at that link (${res.status})`);
  r.bytes=new Uint8Array(await res.arrayBuffer());r.body=new TextDecoder().decode(r.bytes);
  r.text=r.body.replace(/^---\n[\s\S]*?\n---\n\n/,"");r.name=r.body.match(/^---\nsource: (.*)\n/)?.[1]||"";
  r.key=r.path.match(/by_attester\/([a-z2-7]{8})\//)?.[1]||"";
  return r;
 },
 async hash(r){r.cid=cidOf(r.bytes);return r},
 async match(r){const named=r.path.match(/([a-z2-7]{26})\.md$/)?.[1];r.proof=!named?"unnamed":named===r.cid?"match":"changed";return r},
 async resolve(r){
  const res=await fetch(EMEM+"/v1/memory_token/resolve",{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify({token:r.input})});
  const j=await res.json().catch(()=>({}));if(!res.ok)throw new Error(j.message||j.error||`emem said ${res.status}`);
  r.url=r.input;r.cid=r.input.split(":").pop().slice(0,26);r.text=JSON.stringify(j.fact||j,null,1)+"\n";r.proof="token";r.key="emem.dev";
  return r;
 }
};

// ---------- quote check ----------
const norm=s=>s.normalize("NFKC").toLowerCase().replace(/[‘’`]/g,"'").replace(/[“”]/g,'"').replace(/[‐-―]/g,"-").replace(/\s+/g," ").trim();
const quotes=a=>{
 const q=new Set();
 for(const m of a.matchAll(/["“”]([^"“”\n]{12,}?)["“”]/g))q.add(m[1].trim());
 for(const m of a.matchAll(/^>\s?(.{12,})$/gm))q.add(m[1].trim());
 return[...q];
};
const found=(src,q)=>{let at=0;for(const part of norm(q).split(/\s*(?:\.\.\.|…)\s*/).filter(p=>p.length>=4)){const i=src.indexOf(part,at);if(i<0)return false;at=i+part.length}return true};

// ---------- page ----------
const h=(tag,attrs={},...kids)=>{const e=document.createElement(tag);for(const[k,v]of Object.entries(attrs))k.startsWith("on")?e[k]=v:e.setAttribute(k,v);e.append(...kids.flat().filter(x=>x!=null&&x!==false));return e};

const boot=async()=>{
 const src=await(await fetch("./emem.eio",{cache:"no-cache"})).text();
 const P=parse(src),siteCid=cidOf(U(src));
 const spec={accept:P.one("accept").split(/\s+/),limit:+P.one("limit")||2e6};
 const flow=P.steps("flow"),open=P.steps("open");
 document.title=P.one("title");

 const file=h("input",{type:"file",accept:spec.accept.map(e=>"."+e).join(","),hidden:""});
 const box=h("textarea",{placeholder:P.one("in").replace(/^drop\s+/,""),rows:"3",spellcheck:"false","aria-label":"source"});
 const go=h("button",{class:"go","aria-label":"make link"},"→");
 const steps=h("ol",{class:"steps","aria-live":"polite"});
 const out=h("section",{class:"out",hidden:""});
 const who=h("p",{class:"who"}),foot=h("footer",{},h("span",{},"emem.dev"),h("a",{href:"./emem.eio",title:"the source of this page, by hash"},"site · "+siteCid.slice(0,10)));
 const drop=h("div",{class:"drop"},box,h("div",{class:"bar"},h("button",{class:"pick",onclick:()=>file.click()},"choose file"),go),file);
 document.body.replaceChildren(h("main",{},h("h1",{},P.one("hero")),drop,who,steps,out),foot);

 const say=k=>who.textContent=fill(P.one("foot"),{key:k?k.slice(0,8)+"…":"key made on first use"});
 say(null);key().then(k=>say(k.pub)).catch(()=>{});

 const showSteps=(list,done,bad)=>steps.replaceChildren(...list.map((s,i)=>h("li",{class:i<done?"ok":i===done?(bad?"bad":"now"):""},s)));

 const run=async input=>{
  const r={spec};let list=flow;
  if(input instanceof File)r.file=input;
  else{r.input=input.trim();if(!r.input)return;if(NOTE.test(r.input))list=open;else if(TOKEN.test(r.input))list=["resolve"]}
  out.hidden=true;go.disabled=true;
  let i=0;
  try{for(;i<list.length;i++){showSteps(list,i);await ops[list[i]](r)}showSteps(list,i);result(r)}
  catch(e){showSteps(list,i,true);out.hidden=false;out.replaceChildren(h("p",{class:"err"},e.message||String(e)))}
  finally{go.disabled=false}
 };

 const result=r=>{
  const x={url:r.url,cid:r.cid,text:r.text,key:r.key};
  x.prompt=fill(P.one("prompt"),x);x.prompt_text=fill(P.one("prompt_text"),x);
  const proof={match:"✓ bytes match their name",changed:"✗ bytes do not match their name",unnamed:"· name is not a hash",token:"✓ resolved by emem"}[r.proof]||(r.reused?"✓ already on emem":"✓ written, signed");
  const gives=P.all("give").map(g=>{const[kind,label,target]=P.cols(g);
   if(kind==="go")return h("a",{class:"give",href:fill(target,x,true),target:"_blank",rel:"noopener"},label);
   const b=h("button",{class:"give"},label);
   b.onclick=async()=>{try{await navigator.clipboard.writeText(fill(target,x));b.textContent="copied"}catch{b.textContent="copy blocked"}setTimeout(()=>b.textContent=label,1400)};return b});
  const ans=h("textarea",{rows:"4",placeholder:P.one("check"),"aria-label":"answer to check"}),verdict=h("ol",{class:"verdict"});
  const src=norm(r.text);
  ans.oninput=()=>{const q=quotes(ans.value);const n=q.filter(s=>found(src,s)).length;
   verdict.replaceChildren(...(q.length?[h("li",{class:"sum"},`${n} of ${q.length} quotes are in the source`)]:[]),...q.map(s=>h("li",{class:found(src,s)?"yes":"no"},s)))};
  out.hidden=false;
  out.replaceChildren(
   h("a",{class:"url",href:r.url,target:"_blank",rel:"noopener"},r.url),
   h("p",{class:"meta"},[proof,r.name,`${r.text.length.toLocaleString()} chars`,`cid ${r.cid}`].filter(Boolean).join("  ·  ")),
   h("div",{class:"gives"},gives),
   h("div",{class:"check"},ans,verdict));
 };

 go.onclick=()=>run(box.value);
 box.onkeydown=e=>{if(e.key==="Enter"&&(e.metaKey||e.ctrlKey))run(box.value)};
 box.onpaste=e=>{const f=e.clipboardData?.files?.[0];if(f){e.preventDefault();run(f)}};
 file.onchange=()=>file.files[0]&&run(file.files[0]);
 ["dragenter","dragover"].forEach(n=>drop.addEventListener(n,e=>{e.preventDefault();drop.dataset.over=""}));
 ["dragleave","drop"].forEach(n=>drop.addEventListener(n,e=>{e.preventDefault();delete drop.dataset.over}));
 drop.addEventListener("drop",e=>{const f=e.dataTransfer.files[0];if(f)run(f)});
 const q=new URLSearchParams(location.search).get("s");if(q){box.value=q;run(q)}
};
boot().catch(e=>document.body.replaceChildren(document.createTextNode("emem.eio: "+e.message)));
