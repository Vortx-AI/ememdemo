// eio runtime: compiles emem.eio, enforces its rules, draws the page, runs its flows against emem.dev.
import {blake3} from "https://cdn.jsdelivr.net/npm/@noble/hashes@1.8.0/blake3.js/+esm";
import {net,toDoc,REPO,repoItems,blocksOf,pack,describe} from "./read.mjs";

const EMEM="https://emem.dev";
const WRITE=EMEM+"/a2a/tasks"; // /mcp refuses browser origins; /a2a runs the same tools and does not
const NOTE=/^https:\/\/emem\.dev\/memories\/\S+\.md$/;
const LINKS=/https:\/\/emem\.dev\/memories\/by_attester\/[a-z2-7]{8}\/[a-z2-7]{26}\.md/g;

// ---------- compiler ----------
const compile=src=>{
 const st=[],lines=src.split("\n");
 for(let i=0;i<lines.length;i++){
  const l=lines[i].replace(/\s+$/,"");
  if(!l||l.startsWith("#"))continue;
  const m=l.match(/^(\w+)\s*(.*)$/);if(!m)throw new Error(`line ${i+1}: cannot read "${l}"`);
  let[,verb,arg]=m,body=null;
  if(/(^|\s)<<$/.test(arg)){arg=arg.replace(/\s*<<$/,"");const b=[];while(++i<lines.length&&lines[i].trim()!==">>")b.push(lines[i]);body=b.join("\n")}
  st.push({verb,arg,body,line:i+1});
 }
 const one=v=>st.find(s=>s.verb===v)?.arg??"",all=v=>st.filter(s=>s.verb===v);
 const steps={},flows={},kinds={};
 for(const s of all("step")){const m=s.arg.match(/^(\w+)\s*:\s*(\w+)\s*->\s*(\w+)$/);if(!m)throw new Error(`line ${s.line}: step needs "name : A -> B"`);steps[m[1]]={in:m[2],out:m[3]}}
 for(const s of all("flow")){const m=s.arg.match(/^(\w+)\s*:\s*(.+)$/);if(!m)throw new Error(`line ${s.line}: flow needs "name : a b c"`);flows[m[1]]=m[2].split(/\s+/)}
 for(const s of all("kind")){const m=s.arg.match(/^(\w+)\s*:\s*(.+)$/);if(!m)throw new Error(`line ${s.line}: kind needs "name : ext ext"`);for(const e of m[2].split(/\s+/))kinds[e]=m[1]}
 return{one,all,steps,flows,kinds};
};

// every rule is a promise the page makes; if the source breaks one, the page does not render
const rules={
 words(P,[field,range]){const[a,b]=range.split("..").map(Number),n=P.one(field).split(/\s+/).filter(Boolean).length;if(n<a||n>b)return`"${field}" has ${n} words; allowed ${range}`},
 plain(P,args){const i=args.indexOf(":"),fields=args.slice(0,i),banned=args.slice(i+1);
  for(const f of fields){const t=P.one(f).toLowerCase();const hit=banned.find(w=>new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}`).test(t));if(hit)return`"${f}" uses jargon "${hit}" before there is a result`}},
 typed(P,names,ops){for(const n of names){const f=P.flows[n];if(!f)return`flow "${n}" is not defined`;
  for(let i=0;i<f.length;i++){const s=P.steps[f[i]];if(!s)return`flow "${n}": step "${f[i]}" is not declared`;if(!ops[f[i]])return`flow "${n}": step "${f[i]}" has no implementation`;
   if(i&&P.steps[f[i-1]].out!==s.in)return`flow "${n}": ${f[i-1]} gives ${P.steps[f[i-1]].out}, ${f[i]} takes ${s.in}`}}},
 carry(P,args){const need=args.slice(args.indexOf(":")+1);for(const g of P.all("give"))if(!need.some(k=>g.body?.includes(k)))return`output "${g.arg}" carries none of ${need.join(" ")}`}
};
const check=(P,ops)=>P.all("rule").map(r=>{const[name,...args]=r.arg.split(/\s+/);const fn=rules[name];return fn?fn(P,args,ops):`unknown rule "${name}"`}).filter(Boolean);

// ---------- bytes ----------
const U=s=>new TextEncoder().encode(s);
const A="abcdefghijklmnopqrstuvwxyz234567";
const b32=u=>{let b=0,v=0,o="";for(const x of u){v=(v<<8)|x;b+=8;while(b>=5){o+=A[(v>>>(b-5))&31];b-=5}}if(b>0)o+=A[(v<<(5-b))&31];return o};
const cat=(...a)=>{const r=new Uint8Array(a.reduce((n,x)=>n+x.length,0));let i=0;for(const x of a){r.set(x,i);i+=x.length}return r};
const cidOf=bytes=>b32(blake3(bytes).slice(0,16));
const b64=u=>btoa(String.fromCharCode(...new Uint8Array(u)));
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const tokens=n=>"~"+(n<4000?Math.max(1,Math.round(n/4)):Math.round(n/4000)+"k")+" tokens";
const pool=async(items,n,fn)=>{let i=0;await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{while(i<items.length){const k=i++;await fn(items[k],k)}}))};
const store=(k,v)=>{try{if(v===undefined)return JSON.parse(localStorage.getItem(k)||"null");localStorage.setItem(k,JSON.stringify(v))}catch{return null}};

// ---------- key: made in this browser, never sent anywhere ----------
let KEY=null;
const key=async()=>{
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

// ---------- steps ----------
const ops={
 async read(r){
  if(r.files){r.items=r.files.map(f=>({name:f.name,file:f}));r.title=r.files.length===1?r.files[0].name:`${r.files.length} files`;return r}
  const s=r.input,m=s.match(REPO);
  if(m){const g=await repoItems(m,r.spec.kinds,Math.min(r.spec.limit,r.spec.max*r.spec.section*.7));r.items=g.items;r.title=g.name;r.what=g.what}
  else if(/^https?:\/\/\S+$/.test(s))r.items=[{name:s,remote:s}];
  else{r.items=[{name:"pasted text",text:s}];r.title="pasted text"}
  return r;
 },
 async text(r){
  const docs=[],skipped=[];let done=0;
  await pool(r.items,r.items.length<2?1:r.items[0].url?24:6,async(it,i)=>{
   try{docs[i]=await toDoc(it,r.spec.kinds,sub=>r.tick(r.items.length>1?`${done}/${r.items.length}`:sub))}
   catch(e){if(r.items.length===1)throw e;skipped.push(e.message)}
   r.tick(`${++done}/${r.items.length}`);
  });
  r.docs=docs.filter(d=>d&&d.md.replace(/\[page \d+\]/g,"").trim());
  r.skipped=skipped;
  if(!r.docs.length)throw new Error(skipped[0]||"No text found.");
  const size=r.docs.reduce((n,d)=>n+d.md.length,0);
  if(size>r.spec.limit)throw new Error(`Too much text: ${(size/1e6).toFixed(1)} MB. The limit is ${r.spec.limit/1e6} MB per link.`);
  if(r.docs.length===1){const d=r.docs[0];r.title=d.title||r.title||d.name;r.what??=d.what}
  else{r.what??=`${r.docs.length} files`;if(r.files)r.title=`${r.docs.length} files`}
  return r;
 },
 async split(r){
  const multi=r.docs.length>1;
  let docs=r.docs;r.sections=pack(docs.flatMap(d=>blocksOf(d,multi)),r.spec.section);
  while(r.sections.length>r.spec.max&&docs.length>1){docs=docs.slice(0,Math.floor(docs.length*.95));r.sections=pack(docs.flatMap(d=>blocksOf(d,multi)),r.spec.section)}
  if(r.sections.length>r.spec.max)throw new Error(`That makes ${r.sections.length} sections; one link holds ${r.spec.max}. Split the input into smaller files.`);
  if(docs.length<r.docs.length)r.skipped.push(`${r.docs.length-docs.length} lower-ranked files did not fit in one link; paste a folder URL to cover them.`);
  r.about=describe(r.sections,multi);
  r.text=r.sections.map(s=>s.text).join("\n");
  return r;
 },
 async sign(r){
  const k=await key();r.key=k.pub;
  const note=async body=>{const bytes=U(body),cid=cidOf(bytes),path=`/memories/by_attester/${k.pub.slice(0,8)}/${cid}.md`;
   const d=blake3(cat(U(`emem.memory_write.v2|create|${path}|`),blake3(bytes),U("|absent")));
   return{body,bytes,cid,path,url:EMEM+path,sig:b32(new Uint8Array(await crypto.subtle.sign("Ed25519",k.priv,d)))}};
  const n=r.sections.length,total=r.text.length;
  r.notes=await Promise.all(r.sections.map((s,i)=>note(`---\nsource: ${r.title}\nsection: ${i+1} of ${n}: ${r.about[i].title}\n---\n\n${s.text.trim()}\n`)));
  if(n>1){
   const lines=r.sections.map((s,i)=>`- [${r.about[i].title.replace(/[[\]]/g,"")}](${r.notes[i].url}): ${tokens(s.text.length)}${r.about[i].covers?" · "+r.about[i].covers:""}`);
   const skipped=r.skipped.length?`\n## Not included\n\n${r.skipped.slice(0,20).map(x=>"- "+x).join("\n")}${r.skipped.length>20?`\n- and ${r.skipped.length-20} more`:""}\n`:"";
   r.index=await note(`# ${r.title}\n\n> ${r.what}. ${tokens(total)} in ${n} sections. Read this index, then fetch only the sections your task needs. Every link is named by the hash of its bytes.\n\n## Sections\n\n${lines.join("\n")}\n${skipped}`);
  }
  r.shape=n>1?`It is an index of ${n} sections (${tokens(total)} in all); each entry says what its section covers.`:`It is one file (${tokens(total)}).`;
  return r;
 },
 async store(r){
  const all=[...r.notes,...(r.index?[r.index]:[])];let done=0;
  await pool(all,3,async n=>{await put(n,r.key);r.tick(`${++done}/${all.length}`)});
  return r;
 },
 async link(r){
  const top=r.index||r.notes[0],n=r.notes.length+(r.index?1:0);
  Object.assign(r,{url:top.url,cid:top.cid,body:top.body,first:r.notes[0].url,proof:`${n} of ${n} files stored`});
  return r;
 },
 async fetch(r){
  const get=async url=>{const x=await net(url);if(!x.ok)throw new Error(`Nothing is stored at ${url} (${x.status}).`);const bytes=new Uint8Array(await x.arrayBuffer()),named=url.match(/([a-z2-7]{26})\.md$/)?.[1],cid=cidOf(bytes);return{url,cid,ok:named===cid,body:new TextDecoder().decode(bytes)}};
  const top=await get(r.input);Object.assign(r,{url:top.url,cid:top.cid,body:top.body});
  const kids=[...new Set(top.body.match(LINKS)||[])].filter(u=>u!==top.url).slice(0,r.spec.max);
  r.checked=[top];let n=0;
  await pool(kids,6,async u=>{r.checked.push(await get(u));r.tick(`${++n}/${kids.length}`)});
  r.title=top.body.match(/^# (.+)$/m)?.[1]||top.body.match(/^source: (.+)$/m)?.[1]||"";
  return r;
 },
 async prove(r){
  const ok=r.checked.filter(c=>c.ok).length,n=r.checked.length,strip=c=>c.body.replace(/^---\n[\s\S]*?\n---\n\n/,"");
  const bad=r.checked.filter(c=>!c.ok).map(c=>c.url.split("/").pop());
  r.bad=bad.length>0;r.proof=r.bad?`${bad.length} of ${n} files do NOT match their names: ${bad.slice(0,3).join(", ")}${bad.length>3?" …":""}`:`${ok} of ${n} files match their names`;
  const parts=n>1?r.checked.slice(1):r.checked;
  r.text=parts.map(strip).join("\n");r.first=parts[0].url;
  r.shape=n>1?`It is an index of ${n-1} sections (${tokens(r.text.length)} in all); each entry says what its section covers.`:`It is one file (${tokens(r.text.length)}).`;
  return r;
 }
};

// emem.dev lets one key burst about 60 writes, then about 4 a second; stay under both
const bucket={left:40,at:Date.now()};
const slot=async()=>{for(;;){const now=Date.now();bucket.left=Math.min(40,bucket.left+(now-bucket.at)/1000*3.5);bucket.at=now;if(bucket.left>=1){bucket.left--;return}await new Promise(z=>setTimeout(z,(1-bucket.left)/3.5*1000+20))}};
const put=async(n,pub)=>{
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

// ---------- quote check: the stored text is the ground truth ----------
const norm=s=>s.normalize("NFKC").replace(/\[page \d+\]/g," ").replace(/\[([^\]]*)\]\([^)]*\)/g,"$1").toLowerCase()
 .replace(/[‘’`]/g,"'").replace(/[“”]/g,'"').replace(/[*_#>|]/g,"").replace(/[‐-―-]\s*/g,"").replace(/\s+/g," ").trim();
// a quote may hold a quote ("considered "idempotent" if…"): try the outermost span per line first, then each pair
const quotes=(a,src)=>{const q=new Set();
 for(const line of a.split("\n")){
  const at=[...line.matchAll(/["“”]/g)].map(m=>m.index);if(at.length<2)continue;
  const outer=line.slice(at[0]+1,at.at(-1)).trim();
  if(at.length>2&&outer.length>=12&&found(src,outer)){q.add(outer);continue}
  for(let i=0;i+1<at.length;i+=2){const t=line.slice(at[i]+1,at[i+1]).trim();if(t.length>=12)q.add(t)}
 }
 for(const m of a.matchAll(/^>\s?(.{12,})$/gm))q.add(m[1].trim());
 return[...q]};
const found=(src,q)=>{let at=0;for(const part of norm(q).split(/\s*(?:\.\.\.|…)\s*/).filter(p=>p.length>=4)){const i=src.indexOf(part,at);if(i<0)return false;at=i+part.length}return true};

// ---------- page ----------
const h=(tag,attrs={},...kids)=>{const e=document.createElement(tag);for(const[k,v]of Object.entries(attrs))k.startsWith("on")?e[k]=v:e.setAttribute(k,v);e.append(...kids.flat().filter(x=>x!=null&&x!==false));return e};
const fill=(t,x)=>t.replace(/\{(\w+)\}/g,(_,k)=>x[k]??`{${k}}`);

const boot=async()=>{
 const src=await(await fetch("./emem.eio",{cache:"no-cache"})).text();
 const P=compile(src),broken=check(P,ops),siteCid=cidOf(U(src));
 if(broken.length){document.body.replaceChildren(h("pre",{class:"broken"},"emem.eio breaks its own rules:\n\n"+broken.map(b=>"· "+b).join("\n")));return}
 const spec={kinds:P.kinds,limit:+P.one("limit"),section:+P.one("section"),max:+P.one("max")};
 document.title="emem · "+P.one("say");

 const file=h("input",{type:"file",multiple:"",accept:Object.keys(P.kinds).map(e=>"."+e).join(","),hidden:""});
 const box=h("textarea",{placeholder:P.one("in"),rows:"3",spellcheck:"false","aria-label":"what to turn into a link"});
 const go=h("button",{class:"go","aria-label":"make link",title:"make link (Ctrl+Enter)"},"→");
 const drop=h("div",{class:"drop"},box,h("div",{class:"bar"},h("button",{class:"pick",onclick:()=>file.click()},"choose files"),go),file);
 const steps=h("ol",{class:"steps","aria-live":"polite"});
 const link=h("a",{class:"url empty"},P.one("empty")),meta=h("p",{class:"meta"}),grab=h("button",{class:"grab",hidden:""},"copy link");
 const gives=P.all("give"),tabs=h("div",{class:"tabs",role:"tablist"}),pane=h("div",{class:"pane"});
 const code=h("pre",{class:"code",tabindex:"0"}),copy=h("button",{class:"copy"},"copy");
 const ans=h("textarea",{rows:"5",placeholder:P.one("check"),"aria-label":"answer to check"}),verdict=h("ol",{class:"verdict"});
 const out=h("section",{class:"out"},h("div",{class:"row"},link,grab),meta,tabs,pane),recent=h("ol",{class:"recent"}),who=h("span");
 document.body.replaceChildren(
  h("main",{},h("h1",{},P.one("say")),drop,h("p",{class:"note"},P.one("note")),steps,out,recent),
  h("footer",{},who,h("a",{href:"./emem.eio",title:"this page is compiled from this file"},"source · "+siteCid.slice(0,10))));

 let run=null,tab=gives[0].arg;
 const vals=()=>run?.url?{link:run.url,cid:run.cid,title:run.title||"source",shape:run.shape,first:run.first,index:run.body}
  :{link:"‹your link›",cid:"‹hash›",title:"‹name›",shape:"‹what it holds›",first:"‹a section›",index:P.all("sample")[0]?.body||""};
 const draw=()=>{
  tabs.replaceChildren(...[...gives.map(g=>g.arg),"check"].map(n=>h("button",{role:"tab","aria-selected":String(n===tab),onclick:()=>{tab=n;draw()}},n)));
  if(tab==="check"){pane.replaceChildren(ans,verdict);ans.disabled=!run?.text;ans.oninput()}
  else{code.textContent=fill(gives.find(g=>g.arg===tab).body,vals());code.classList.toggle("ghost",!run?.url);copy.disabled=!run?.url;pane.replaceChildren(code,copy)}
 };
 ans.oninput=()=>{if(!run?.text){verdict.replaceChildren();return}const src=norm(run.text),q=quotes(ans.value,src),n=q.filter(s=>found(src,s)).length;
  verdict.replaceChildren(...(q.length?[h("li",{class:"sum"},`${n} of ${q.length} quotes are in the source`)]:ans.value.trim()?[h("li",{class:"sum"},'no "quotes" found in the answer')]:[]),...q.map(s=>h("li",{class:found(src,s)?"yes":"no"},s)))};
 grab.onclick=async()=>{try{await navigator.clipboard.writeText(run.url);grab.textContent="copied"}catch{grab.textContent="select and copy"}setTimeout(()=>grab.textContent="copy link",1400)};
 copy.onclick=async()=>{try{await navigator.clipboard.writeText(code.textContent);copy.textContent="copied"}catch{copy.textContent="select and copy"}setTimeout(()=>copy.textContent="copy",1400)};
 const drawRecent=()=>{const list=store("emem.recent")||[];recent.replaceChildren(...(list.length?[h("li",{class:"sum"},"recent")]:[]),
  ...list.map(x=>h("li",{},h("button",{onclick:()=>{box.value=x.url;start(x.url)}},x.title),h("span",{},x.shape))))};
 draw();drawRecent();
 key().then(k=>who.textContent="key "+k.pub.slice(0,8)+" · kept in this browser").catch(()=>who.textContent="emem.dev");

 const show=(list,at,sub,bad)=>steps.replaceChildren(...list.map((s,i)=>h("li",{class:i<at?"ok":i===at?(bad?"bad":"now"):""},s+(i===at&&sub?" "+sub:""))));
 const start=async input=>{
  const r={spec};let list=P.flows.make;
  if(Array.isArray(input))r.files=input;else{r.input=input.trim();if(NOTE.test(r.input))list=P.flows.open}
  if(!r.files?.length&&!r.input){steps.replaceChildren(h("li",{class:"bad"},P.one("blank")));if(!run)meta.textContent="";box.focus();return}
  let i=0;r.tick=sub=>show(list,i,sub);
  go.disabled=true;run=null;grab.hidden=true;link.className="url empty";link.textContent="…";link.removeAttribute("href");meta.className="meta";meta.textContent="";draw();
  try{
   for(;i<list.length;i++){show(list,i);await ops[list[i]](r)}
   show(list,i);run=r;
   link.className="url";link.textContent=r.url;link.href=r.url;link.target="_blank";link.rel="noopener";grab.hidden=false;
   meta.className="meta"+(r.bad?" bad":"");
   const secs=r.notes?.length??(r.checked.length>1?r.checked.length-1:1),size=secs>1?`${secs} sections, ${tokens(r.text.length)}`:tokens(r.text.length);
   meta.textContent=[r.proof,secs>1?`${size}; the index is ${tokens(r.body.length)}`:size,r.skipped?.length?`${r.skipped.length} not included`:""].filter(Boolean).join("  ·  ");
   if(!r.bad){history.replaceState(null,"","?s="+encodeURIComponent(r.url));
    store("emem.recent",[{url:r.url,title:r.title||r.url,shape:size},...(store("emem.recent")||[]).filter(x=>x.url!==r.url)].slice(0,8));drawRecent()}
   if(out.getBoundingClientRect().top>innerHeight*.6)out.scrollIntoView({behavior:"smooth",block:"start"});
  }catch(e){show(list,i,"",true);link.textContent=P.one("empty");meta.className="meta bad";meta.textContent=e.message||String(e)}
  finally{go.disabled=false;draw()}
 };

 go.onclick=()=>start(box.value);
 box.onkeydown=e=>{if(e.key==="Enter"&&(e.metaKey||e.ctrlKey))start(box.value)};
 box.onpaste=e=>{const f=[...(e.clipboardData?.files||[])];if(f.length){e.preventDefault();start(f)}};
 file.onchange=()=>{start([...file.files]);file.value=""};
 // a file dropped anywhere on the page is read, never opened by the browser
 addEventListener("dragover",e=>{e.preventDefault();drop.dataset.over=""});
 addEventListener("dragleave",e=>{if(!e.relatedTarget)delete drop.dataset.over});
 addEventListener("drop",e=>{e.preventDefault();delete drop.dataset.over;const f=[...(e.dataTransfer?.files||[])];if(f.length)start(f)});
 const s=new URLSearchParams(location.search).get("s");if(s){box.value=s;start(s)}
};
boot().catch(e=>document.body.replaceChildren(document.createTextNode("emem.eio: "+e.message)));
