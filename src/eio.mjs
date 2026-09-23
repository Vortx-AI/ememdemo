// eio runtime: compiles emem.eio, enforces its rules, draws the page, runs its flows against emem.dev.
import {blake3} from "https://cdn.jsdelivr.net/npm/@noble/hashes@1.8.0/blake3.js/+esm";

const EMEM="https://emem.dev";
const WRITE=EMEM+"/a2a/tasks"; // /mcp refuses browser origins; /a2a runs the same tools and does not
const PDFJS="https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
const PDFW="https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
const MAMMOTH="https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js";
const READER="https://r.jina.ai/";
const NOTE=/^https:\/\/emem\.dev\/memories\/\S+\.md$/;
const LINKS=/https:\/\/emem\.dev\/memories\/by_attester\/[a-z2-7]{8}\/[a-z2-7]{26}\.md/g;
const REPO=/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(?:tree\/([^/\s]+)\/?)?$/;

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
 const steps={},flows={};
 for(const s of all("step")){const m=s.arg.match(/^(\w+)\s*:\s*(\w+)\s*->\s*(\w+)$/);if(!m)throw new Error(`line ${s.line}: step needs "name : A -> B"`);steps[m[1]]={in:m[2],out:m[3]}}
 for(const s of all("flow")){const m=s.arg.match(/^(\w+)\s*:\s*(.+)$/);if(!m)throw new Error(`line ${s.line}: flow needs "name : a b c"`);flows[m[1]]=m[2].split(/\s+/)}
 return{one,all,steps,flows};
};

// every rule is a promise the page makes; if the source breaks one, the page does not render
const rules={
 words(P,[field,range]){const[a,b]=range.split("..").map(Number),n=P.one(field).split(/\s+/).filter(Boolean).length;if(n<a||n>b)return`"${field}" has ${n} words; allowed ${range}`},
 plain(P,args){const i=args.indexOf(":"),fields=args.slice(0,i),banned=args.slice(i+1);
  for(const f of fields){const t=P.one(f).toLowerCase();const hit=banned.find(w=>new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}`).test(t));if(hit)return`"${f}" uses jargon "${hit}" before there is a result`}},
 typed(P,names,ops){for(const n of names){const f=P.flows[n];if(!f)return`flow "${n}" is not defined`;
  for(let i=0;i<f.length;i++){const s=P.steps[f[i]];if(!s)return`flow "${n}": step "${f[i]}" is not declared`;if(!ops[f[i]])return`flow "${n}": step "${f[i]}" has no implementation`;
   if(i&&P.steps[f[i-1]].out!==s.in)return`flow "${n}": ${f[i-1]} gives ${P.steps[f[i-1]].out}, ${f[i]} takes ${s.in}`}}}
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

// ---------- key: made in this browser, never sent anywhere ----------
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
 }catch{throw new Error("This browser cannot sign (no Ed25519). Update it and try again.")}
 return KEY;
};

// ---------- extraction ----------
const ext=n=>(n.match(/\.([a-z0-9]+)$/i)?.[1]||"").toLowerCase();
const pdfPages=async buf=>{
 const pdf=await import(PDFJS);
 if(!pdf.GlobalWorkerOptions.workerPort)pdf.GlobalWorkerOptions.workerPort=new Worker(URL.createObjectURL(new Blob([`import "${PDFW}";`],{type:"text/javascript"})),{type:"module"});
 const doc=await pdf.getDocument({data:buf}).promise,out=[];
 for(let p=1;p<=doc.numPages;p++){const c=await(await doc.getPage(p)).getTextContent();out.push(c.items.map(i=>i.str+(i.hasEOL?"\n":"")).join(""))}
 return out;
};
const script=src=>new Promise((ok,no)=>{const s=document.createElement("script");s.src=src;s.onload=ok;s.onerror=()=>no(new Error("could not load "+src));document.head.append(s)});
const docxText=async buf=>{if(!window.mammoth)await script(MAMMOTH);return(await window.mammoth.extractRawText({arrayBuffer:buf})).value};
const htmlText=s=>new DOMParser().parseFromString(s,"text/html").body?.textContent||"";
const clean=s=>s.replace(/\r\n?/g,"\n").replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
const SKIP=/(^|\/)(node_modules|dist|build|vendor|\.git|\.next|target|coverage|__pycache__)\/|(\.min\.|\.lock$|package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$|\.map$)/;

const repoItems=async(m,r)=>{
 const[,o,n,ref]=m,gh=p=>fetch("https://api.github.com/repos/"+o+"/"+n+p).then(async x=>{if(!x.ok)throw new Error(x.status===403?"GitHub rate limit reached (60 an hour without login). Try again later.":`GitHub: ${o}/${n} not found or private`);return x.json()});
 const branch=ref||(await gh("")).default_branch;
 const tree=await gh(`/git/trees/${encodeURIComponent(branch)}?recursive=1`);
 const rank=p=>/^readme/i.test(p)?0:/^docs?\//i.test(p)?1:/\.(md|mdx|rst|txt)$/i.test(p)?2:3;
 const files=tree.tree.filter(t=>t.type==="blob"&&t.size<300000&&r.spec.accept.includes(ext(t.path))&&!SKIP.test(t.path)).sort((a,b)=>rank(a.path)-rank(b.path)||a.path.localeCompare(b.path));
 let total=0;const pick=[];for(const f of files){if(total+f.size>r.spec.limit)break;total+=f.size;pick.push(f)}
 if(!pick.length)throw new Error("No readable text files in that repo.");
 r.name=`${o}/${n}`;
 return pick.map(f=>({name:f.path,url:`https://raw.githubusercontent.com/${o}/${n}/${encodeURIComponent(branch)}/${f.path.split("/").map(encodeURIComponent).join("/")}`}));
};

// ---------- splitting: sections an agent can fetch one at a time ----------
const splitText=(title,text,max)=>{
 const blocks=[];let cur={title,text:""};
 for(const line of text.split("\n")){
  const h=line.match(/^#{1,3}\s+(.{1,90})/);
  if(h&&cur.text.trim()){blocks.push(cur);cur={title:`${title} · ${h[1].trim()}`,text:""}}
  cur.text+=line+"\n";
 }
 blocks.push(cur);
 const out=[];
 for(const b of blocks){
  if(b.text.length>max){let part="",k=1;for(const p of b.text.split(/\n\n/)){if(part&&part.length+p.length>max){out.push({title:`${b.title} (${k++})`,text:part});part=""}part+=(part?"\n\n":"")+p.slice(0,max)}if(part)out.push({title:k>1?`${b.title} (${k})`:b.title,text:part});continue}
  const last=out.at(-1);
  if(last&&last.text.length+b.text.length<=max/3&&last.title.split(" · ")[0]===b.title.split(" · ")[0])last.text+=b.text;else out.push({...b});
 }
 return out.filter(s=>s.text.trim());
};

// ---------- steps ----------
const ops={
 async read(r){
  if(r.files){r.items=r.files.map(f=>({name:f.name,file:f}));r.name=r.files.length===1?r.files[0].name:`${r.files.length} files`;return r}
  const s=r.input.trim(),m=s.match(REPO);
  if(m)r.items=await repoItems(m,r);
  else if(/^https?:\/\/\S+$/.test(s)){r.items=[{name:s,remote:s}];r.name=s}
  else{r.items=[{name:"text",text:s}];r.name="pasted text"}
  return r;
 },
 async text(r){
  r.docs=[];
  await pool(r.items,6,async(it,i)=>{
   let t,pages;
   if(it.file){
    const e=ext(it.name);
    if(!r.spec.accept.includes(e))throw new Error(`${it.name}: .${e||"?"} is not supported. Supported: ${r.spec.accept.join(" ")}`);
    const buf=await it.file.arrayBuffer();
    if(e==="pdf"){pages=(await pdfPages(buf)).map(clean);if(!pages.join("").trim())throw new Error(`${it.name} is a scanned PDF with no text layer. OCR is not done here.`)}
    else t=e==="docx"?await docxText(buf):new TextDecoder().decode(buf);
    if(e==="html"||e==="htm")t=htmlText(t);
   }else if(it.url){const x=await fetch(it.url);if(!x.ok)return;t=await x.text()}
   else if(it.remote){const x=await fetch(READER+it.remote);if(!x.ok)throw new Error(`Could not read that URL (${x.status}).`);t=await x.text()}
   else t=it.text;
   r.docs[i]={name:it.name,text:pages?null:clean(t),pages};
   r.tick(`${r.docs.filter(Boolean).length}/${r.items.length}`);
  });
  r.docs=r.docs.filter(d=>d&&(d.pages?.join("").trim()||d.text?.trim()));
  const size=r.docs.reduce((n,d)=>n+(d.text??d.pages.join("")).length,0);
  if(!size)throw new Error("No text found.");
  if(size>r.spec.limit)throw new Error(`Too much text: ${(size/1e6).toFixed(1)} MB. The limit is ${r.spec.limit/1e6} MB.`);
  return r;
 },
 async split(r){
  const max=r.spec.section,multi=r.docs.length>1;r.sections=[];
  for(const d of r.docs){
   if(d.pages){let from=1,buf="";d.pages.forEach((p,i)=>{if(buf&&buf.length+p.length>max){r.sections.push({title:`${d.name} · pages ${from}–${i}`,text:buf});buf="";from=i+1}buf+=(buf?"\n\n":"")+p});if(buf)r.sections.push({title:`${d.name} · pages ${from}–${d.pages.length}`,text:buf})}
   else r.sections.push(...splitText(multi||r.items[0].file||r.items[0].remote?d.name:"text",d.text,max));
  }
  if(r.sections.length>r.spec.max)throw new Error(`That makes ${r.sections.length} sections; the limit is ${r.spec.max}. Drop fewer files.`);
  r.text=r.sections.map(s=>s.text).join("\n\n");
  return r;
 },
 async sign(r){
  const k=await key();r.key=k.pub;
  const note=async body=>{const bytes=U(body),cid=cidOf(bytes),path=`/memories/by_attester/${k.pub.slice(0,8)}/${cid}.md`;
   const d=blake3(cat(U(`emem.memory_write.v2|create|${path}|`),blake3(bytes),U("|absent")));
   return{body,bytes,cid,path,url:EMEM+path,sig:b32(new Uint8Array(await crypto.subtle.sign("Ed25519",k.priv,d)))}};
  const n=r.sections.length;
  r.notes=await Promise.all(r.sections.map((s,i)=>note(`---\nsource: ${r.name}\nsection: ${i+1} of ${n} · ${s.title}\n---\n\n${s.text.trim()}\n`)));
  if(n>1){
   const total=r.sections.reduce((a,s)=>a+s.text.length,0);
   const index=`# ${r.name}\n\n> ${n} sections, ${tokens(total)}. Read this list, then fetch only the sections the task needs. Each file is named by the hash of its bytes.\n\n`+
    r.sections.map((s,i)=>`- [${s.title.replace(/[[\]]/g,"")}](${r.notes[i].url}) · ${tokens(s.text.length)}`).join("\n")+"\n";
   r.index=await note(index);
  }
  r.shape=n>1?`It is an index of ${n} sections (${tokens(r.text.length)})`:`It is one file (${tokens(r.text.length)})`;
  return r;
 },
 async store(r){
  const all=[...r.notes,...(r.index?[r.index]:[])];let done=0;
  await pool(all,3,async n=>{await put(n,r.key);r.tick(`${++done}/${all.length}`)});
  return r;
 },
 async link(r){const top=r.index||r.notes[0];r.url=top.url;r.cid=top.cid;r.verified=`${r.notes.length+(r.index?1:0)} of ${r.notes.length+(r.index?1:0)} files stored`;return r},
 async fetch(r){
  const get=async url=>{const x=await fetch(url);if(!x.ok)throw new Error(`Nothing at ${url} (${x.status}).`);const bytes=new Uint8Array(await x.arrayBuffer()),named=url.match(/([a-z2-7]{26})\.md$/)?.[1],cid=cidOf(bytes);return{url,cid,ok:named===cid,body:new TextDecoder().decode(bytes)}};
  const top=await get(r.input);r.url=top.url;r.cid=top.cid;
  const kids=[...new Set(top.body.match(LINKS)||[])].slice(0,r.spec.max);
  r.checked=[top];
  if(kids.length){let n=0;await pool(kids,6,async u=>{r.checked.push(await get(u));r.tick(`${++n}/${kids.length}`)})}
  r.name=top.body.match(/^# (.+)$/m)?.[1]||top.body.match(/^source: (.+)$/m)?.[1]||"";
  return r;
 },
 async prove(r){
  const ok=r.checked.filter(c=>c.ok).length,n=r.checked.length;
  r.verified=ok===n?`${ok} of ${n} files match their names`:`${n-ok} of ${n} files do NOT match their names`;
  r.bad=ok!==n;
  const body=c=>c.body.replace(/^---\n[\s\S]*?\n---\n\n/,"");
  r.text=(r.checked.length>1?r.checked.slice(1):r.checked).map(body).join("\n\n");
  r.shape=r.checked.length>1?`It is an index of ${r.checked.length-1} sections (${tokens(r.text.length)})`:`It is one file (${tokens(r.text.length)})`;
  return r;
 }
};

const put=async(n,pub)=>{
 for(let attempt=0;;attempt++){
  const x=await fetch(WRITE,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},
   body:JSON.stringify({skill:"emem_memory_create",args:{path:n.path,file_text:n.body,kind:"resource",attester:{pubkey_b32:pub,sig_b32:n.sig}}})});
  if(x.ok)return;
  if(x.status===429&&attempt<5){await new Promise(z=>setTimeout(z,1000*(attempt+1)));continue}
  const j=await x.json().catch(()=>({}));
  // same bytes, same name: if it is already there and hashes right, it is the same file
  const back=await fetch(n.url).catch(()=>null);
  if(back?.ok&&cidOf(new Uint8Array(await back.arrayBuffer()))===n.cid)return;
  throw new Error("emem refused the write: "+String(j.message||j.error||x.status).split("\n")[0].replace(/^a2a skill `\w+` failed: \(-?\d+\)\s*/,""));
 }
};

// ---------- quote check ----------
const norm=s=>s.normalize("NFKC").toLowerCase().replace(/[‘’`]/g,"'").replace(/[“”]/g,'"').replace(/[‐-―]/g,"-").replace(/\s+/g," ").trim();
const quotes=a=>{const q=new Set();for(const m of a.matchAll(/["“”]([^"“”\n]{12,}?)["“”]/g))q.add(m[1].trim());for(const m of a.matchAll(/^>\s?(.{12,})$/gm))q.add(m[1].trim());return[...q]};
const found=(src,q)=>{let at=0;for(const part of norm(q).split(/\s*(?:\.\.\.|…)\s*/).filter(p=>p.length>=4)){const i=src.indexOf(part,at);if(i<0)return false;at=i+part.length}return true};

// ---------- page ----------
const h=(tag,attrs={},...kids)=>{const e=document.createElement(tag);for(const[k,v]of Object.entries(attrs))k.startsWith("on")?e[k]=v:e.setAttribute(k,v);e.append(...kids.flat().filter(x=>x!=null&&x!==false));return e};
const fill=(t,x)=>t.replace(/\{(\w+)\}/g,(_,k)=>x[k]??`{${k}}`);

const boot=async()=>{
 const src=await(await fetch("./emem.eio",{cache:"no-cache"})).text();
 const P=compile(src),broken=check(P,ops),siteCid=cidOf(U(src));
 if(broken.length){document.body.replaceChildren(h("pre",{class:"broken"},"emem.eio breaks its own rules:\n\n"+broken.map(b=>"· "+b).join("\n")));return}
 const spec={accept:P.one("accept").split(/\s+/),limit:+P.one("limit"),section:+P.one("section"),max:+P.one("max")};
 document.title="emem · "+P.one("say");

 const file=h("input",{type:"file",multiple:"",accept:spec.accept.map(e=>"."+e).join(","),hidden:""});
 const box=h("textarea",{placeholder:P.one("in"),rows:"3",spellcheck:"false","aria-label":"source"});
 const go=h("button",{class:"go","aria-label":"make link"},"→");
 const drop=h("div",{class:"drop"},box,h("div",{class:"bar"},h("button",{class:"pick",onclick:()=>file.click()},"choose files"),go),file);
 const steps=h("ol",{class:"steps","aria-live":"polite"});
 const link=h("a",{class:"url empty"},P.one("empty")),meta=h("p",{class:"meta"});
 const gives=P.all("give"),tabs=h("div",{class:"tabs",role:"tablist"}),pane=h("div",{class:"pane"});
 const code=h("pre",{class:"code"}),copy=h("button",{class:"copy"},"copy");
 const ans=h("textarea",{rows:"4",placeholder:P.one("check"),"aria-label":"answer to check"}),verdict=h("ol",{class:"verdict"});
 const who=h("span");
 document.body.replaceChildren(
  h("main",{},h("h1",{},P.one("say")),drop,h("p",{class:"note"},P.one("note")),steps,
   h("section",{class:"out"},link,meta,tabs,pane)),
  h("footer",{},who,h("a",{href:"./emem.eio",title:"this page is compiled from this file"},"source · "+siteCid.slice(0,10))));

 let run=null,tab=gives[0].arg;
 const vals=()=>run?.url?{link:run.url,cid:run.cid,shape:run.shape}:{link:"‹your link›",cid:"‹hash›",shape:"‹what it contains›"};
 const draw=()=>{
  tabs.replaceChildren(...[...gives.map(g=>g.arg),"check"].map(n=>h("button",{role:"tab","aria-selected":String(n===tab),onclick:()=>{tab=n;draw()}},n)));
  if(tab==="check"){pane.replaceChildren(ans,verdict);ans.disabled=!run?.text;ans.oninput()}
  else{code.textContent=fill(gives.find(g=>g.arg===tab).body,vals());code.classList.toggle("ghost",!run?.url);copy.disabled=!run?.url;pane.replaceChildren(code,copy)}
 };
 ans.oninput=()=>{if(!run?.text){verdict.replaceChildren();return}const src=norm(run.text),q=quotes(ans.value),n=q.filter(s=>found(src,s)).length;
  verdict.replaceChildren(...(q.length?[h("li",{class:"sum"},`${n} of ${q.length} quotes are in the source`)]:[]),...q.map(s=>h("li",{class:found(src,s)?"yes":"no"},s)))};
 copy.onclick=async()=>{try{await navigator.clipboard.writeText(code.textContent);copy.textContent="copied"}catch{copy.textContent="copy blocked"}setTimeout(()=>copy.textContent="copy",1400)};
 draw();
 key().then(k=>who.textContent="key "+k.pub.slice(0,8)+" · this browser").catch(()=>who.textContent="emem.dev");

 const show=(list,at,sub,bad)=>steps.replaceChildren(...list.map((s,i)=>h("li",{class:i<at?"ok":i===at?(bad?"bad":"now"):""},s+(i===at&&sub?" "+sub:""))));
 const start=async input=>{
  const r={spec};let list=P.flows.make;
  if(Array.isArray(input)){if(!input.length)return;r.files=input}
  else{r.input=input.trim();if(!r.input)return;if(NOTE.test(r.input))list=P.flows.open}
  let i=0;r.tick=sub=>show(list,i,sub);
  go.disabled=true;run=null;link.className="url empty";link.textContent="…";link.removeAttribute("href");meta.textContent="";draw();
  try{for(;i<list.length;i++){show(list,i);await ops[list[i]](r)}show(list,i);run=r;
   link.className="url";link.textContent=r.url;link.href=r.url;link.target="_blank";
   meta.className="meta"+(r.bad?" bad":"");meta.textContent=[r.verified,r.shape.replace(/^It is /,"")].join("  ·  ");
   if(!r.bad&&list===P.flows.make)history.replaceState(null,"","?s="+encodeURIComponent(r.url));
  }catch(e){show(list,i,"",true);link.textContent=P.one("empty");meta.className="meta bad";meta.textContent=e.message||String(e)}
  finally{go.disabled=false;draw()}
 };

 go.onclick=()=>start(box.value);
 box.onkeydown=e=>{if(e.key==="Enter"&&(e.metaKey||e.ctrlKey))start(box.value)};
 box.onpaste=e=>{const f=[...(e.clipboardData?.files||[])];if(f.length){e.preventDefault();start(f)}};
 file.onchange=()=>start([...file.files]);
 ["dragenter","dragover"].forEach(n=>drop.addEventListener(n,e=>{e.preventDefault();drop.dataset.over=""}));
 ["dragleave","drop"].forEach(n=>drop.addEventListener(n,e=>{e.preventDefault();delete drop.dataset.over}));
 drop.addEventListener("drop",e=>start([...e.dataTransfer.files]));
 const s=new URLSearchParams(location.search).get("s");if(s){box.value=s;start(s)}
};
boot().catch(e=>document.body.replaceChildren(document.createTextNode("emem.eio: "+e.message)));
