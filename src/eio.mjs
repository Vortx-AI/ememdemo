// eio runtime: compiles emem.eio, enforces its rules, draws the page, runs its flows against emem.dev.
import {EMEM,NOTE,LINKS,CID,STH,ASK,U,cidOf,tokens,pool,store,net,key,note,put,getNote,tokenType,resolveToken,ask,summarize,feed,readVia,guard,exportKey,importKey} from "./emem.mjs";
import {toDoc,REPO,repoItems,blocksOf,pack,describe} from "./read.mjs";
import {compile} from "./lang.mjs";

// every rule is a promise the page makes; if the source breaks one, the page does not render
const rules={
 words(P,[field,range]){const[a,b]=range.split("..").map(Number),n=P.one(field).split(/\s+/).filter(Boolean).length;if(n<a||n>b)return`"${field}" has ${n} words; allowed ${range}`},
 plain(P,args){const i=args.indexOf(":"),fields=args.slice(0,i),banned=args.slice(i+1);
  for(const f of fields){const t=P.one(f).toLowerCase();const hit=banned.find(w=>new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}`).test(t));if(hit)return`"${f}" uses jargon "${hit}" before there is a result`}},
 typed(P,names,ops){for(const n of names){const f=P.flows[n];if(!f)return`flow "${n}" is not defined`;
  for(let i=0;i<f.length;i++){const s=P.steps[f[i]];if(!s)return`flow "${n}": step "${f[i]}" is not declared`;if(!ops[f[i]])return`flow "${n}": step "${f[i]}" has no implementation`;
   if(i&&P.steps[f[i-1]].out!==s.in)return`flow "${n}": ${f[i-1]} gives ${P.steps[f[i-1]].out}, ${f[i]} takes ${s.in}`}}},
 // every card opens something this page can open, and every sample it runs is a kind it can read
 gallery(P){for(const s of P.shows){const t=s.emem||"",m=t.match(/^emem:([a-z]+):/);
  if(!(NOTE.test(t)||CID.test(t)||STH.test(t)||ASK.test(t)||t==="live"||t==="self"||(m&&P.tokens[m[1]])))return`gallery card "${s.title}" points at something this page cannot open`;
  if(s.from?.startsWith("./")&&!P.kinds[(s.from.match(/\.([a-z0-9]+)$/i)||[])[1]?.toLowerCase()])return`gallery card "${s.title}" runs a file this page cannot read`}},
 carry(P,args){const need=args.slice(args.indexOf(":")+1);for(const g of P.all("give"))if(!need.some(k=>g.body?.includes(k)))return`output "${g.arg}" carries none of ${need.join(" ")}`}
};
const check=(P,ops)=>P.all("rule").map(r=>{const[name,...args]=r.arg.split(/\s+/);const fn=rules[name];return fn?fn(P,args,ops):`unknown rule "${name}"`}).filter(Boolean);

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
  const docs=[],skipped=[];let done=0,gone=0;
  await pool(r.items,r.items.length<2?1:r.items[0].url?24:6,async(it,i)=>{
   try{docs[i]=await toDoc(it,r.spec.kinds,sub=>r.tick(r.items.length>1?`${done}/${r.items.length}`:sub))}
   catch(e){if(r.items.length===1)throw e;if(e.gone)gone++;else skipped.push(e.message)}
   r.tick(`${++done}/${r.items.length}`);
  });
  r.docs=docs.filter(d=>d&&d.md.replace(/\[page \d+\]/g,"").trim());
  r.skipped=gone?[`${gone} listed files are no longer there (the file listing is cached)`,...skipped]:skipped;
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
  const n=r.sections.length,total=r.text;
  r.notes=await Promise.all(r.sections.map((s,i)=>note(`---\nsource: ${r.title}\nsection: ${i+1} of ${n}: ${r.about[i].title}\n---\n\n${s.text.trim()}\n`,k)));
  if(n>1){
   const lines=r.sections.map((s,i)=>`- [${r.about[i].title.replace(/[[\]]/g,"")}](${r.notes[i].url}): ${tokens(s.text)}${r.about[i].covers?" · "+r.about[i].covers:""}${r.about[i].terms?" · "+r.about[i].terms:""}`);
   const skipped=r.skipped.length?`\n## Not included\n\n${r.skipped.slice(0,20).map(x=>"- "+x).join("\n")}${r.skipped.length>20?`\n- and ${r.skipped.length-20} more`:""}\n`:"";
   r.index=await note(`# ${r.title}\n\n> ${r.what}. ${tokens(total)} in ${n} sections. Read this index, then fetch only the sections your task needs. Every link is named by the hash of its bytes.\n\n## Sections\n\n${lines.join("\n")}\n${skipped}`,k);
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
  Object.assign(r,{url:top.url,cid:top.cid,body:top.body,first:r.notes[0].url,proof:`${n} of ${n} files stored`+(r.index?` · one name commits to all ${r.notes.length} sections`:"")});
  Object.assign(r,readVia(r));
  return r;
 },
 async fetch(r){
  const top=await getNote(r.input);Object.assign(r,{url:top.url,cid:top.cid,body:top.body});
  const kids=[...new Set(top.body.match(LINKS)||[])].filter(u=>u!==top.url).slice(0,r.spec.max);
  r.checked=[top];let n=0;
  await pool(kids,6,async u=>{r.checked.push(await getNote(u));r.tick(`${++n}/${kids.length}`)});
  r.title=top.body.match(/^# (.+)$/m)?.[1]||top.body.match(/^source: (.+)$/m)?.[1]||"";
  return r;
 },
 // any emem name: a token from the family, or a bare file name; resolved, and its receipt checked
 async resolve(r){Object.assign(r,await resolveToken(r.input,r.spec,r.tick));return r},
 // a question about a place, answered by emem.dev with signed facts
 async ask(r){Object.assign(r,await ask(r.input.match(ASK)[1].trim(),r.spec,r.tick));return r},
 async prove(r){
  const n=r.checked.length,strip=c=>c.body.replace(/^---\n[\s\S]*?\n---\n\n/,"");
  const bad=r.checked.filter(c=>c.ok===false).map(c=>c.url.split("/").pop()),unnamed=r.checked.filter(c=>c.ok==null).length,ok=n-bad.length-unnamed;
  r.bad=bad.length>0;
  r.proof=r.bad?`${bad.length} of ${n} files do NOT match their names: ${bad.slice(0,3).join(", ")}${bad.length>3?" …":""}`
   :unnamed===n?`not named by its hash, so there is nothing to match (its hash is ${r.cid})`:`${ok} of ${n} files match their names`+(unnamed?` · ${unnamed} not named by hash`:"")+(n>1&&!unnamed?` · one name commits to all ${n-1} sections`:"");
  const parts=n>1?r.checked.slice(1):r.checked;
  r.text=parts.map(strip).join("\n");r.first=parts[0].url;
  r.shape=n>1?`It is an index of ${n-1} sections (${tokens(r.text)} in all); each entry says what its section covers.`:`It is one file (${tokens(r.text)}).`;
  Object.assign(r,readVia(r));
  return r;
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

// beyond quotes: how much of each sentence traces to the source word for word, and whether its numbers are in the source.
// trace = share of the sentence's 3-word runs that occur in the source; a paraphrase scores low, which is the honest reading.
const words3=t=>{const w=norm(t).replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(Boolean),o=[];for(let i=0;i+2<w.length;i++)o.push(w[i]+" "+w[i+1]+" "+w[i+2]);return o};
// numbers are compared by value at the answer's own precision: "915.07" holds against 915.0712…; digits inside tokens and links are not numbers
const strip=t=>t.replace(/emem:[a-z]+:\S+|https?:\/\/\S+/g," ");
const nums=t=>(strip(t).match(/\d[\d,]*(?:\.\d+)?/g)||[]).map(x=>x.replace(/,/g,"")).filter(x=>x.replace(/\D/g,"").length>1);
const SW=new Set("the and for that with this from are was were been have has not but can will may must which their there these those into than then when what where who how all any each other such only also more most some very uses used using about over under between after before does".split(" "));
// a number counts only where the source has it next to the words it came with: an occurrence within ±250 characters
// of at least two of the sentence's other content words (one, if the sentence has fewer than three)
const numberHeld=(n,sentence,src,srcNums,prose)=>{
 const ctx=[...new Set((norm(strip(sentence)).match(/[a-z][a-z-]{3,}/g)||[]).filter(w=>!SW.has(w)))],need=ctx.length<3?1:2;
 const v=Number(n),tol=.5*10**-((n.split(".")[1]||"").length);
 // a record from the token family has no prose around its numbers: there the value alone must match
 return srcNums.some(m=>Math.abs(m.v-v)<=tol&&(!prose||ctx.filter(w=>src.slice(Math.max(0,m.at-250),m.at+250).includes(w)).length>=need));
};
const grounding=(answer,source,prose=true)=>{
 const grams=new Set(words3(source)),src=norm(source).replace(/(\d),(\d)/g,"$1$2");
 const srcNums=[...src.matchAll(/\d+(?:\.\d+)?/g)].map(m=>({v:Number(m[0]),at:m.index}));
 const sentences=answer.split(/(?<=[.!?])\s+|\n+/).map(x=>x.trim()).filter(Boolean);
 const traced=sentences.filter(x=>x.split(/\s+/).length>=6).map(x=>{const g=words3(x);return{x,score:g.length?g.filter(y=>grams.has(y)).length/g.length:0}});
 const numbers=sentences.flatMap(x=>[...new Set(nums(x))].map(n=>({n,ok:numberHeld(n,x,src,srcNums,prose),x})));
 return{traced,numbers};
};

// ---------- page ----------
const h=(tag,attrs={},...kids)=>{const e=document.createElement(tag);for(const[k,v]of Object.entries(attrs))k.startsWith("on")?e[k]=v:e.setAttribute(k,v);e.append(...kids.flat().filter(x=>x!=null&&x!==false));return e};
const fill=(t,x)=>t.replace(/\{(\w+)\}/g,(_,k)=>x[k]??`{${k}}`);

const boot=async()=>{
 // a sealed page hands over the source it already checked; unsealed, it reads the file as it is
 const src=globalThis.__seal?.files?.["emem.eio"]?.text??await(await fetch("./emem.eio",{cache:"no-cache"})).text();
 const P=compile(src),broken=check(P,ops);
 if(broken.length){document.body.replaceChildren(h("pre",{class:"broken"},"emem.eio breaks its own rules:\n\n"+broken.map(b=>"· "+b).join("\n")));return}
 const spec={kinds:P.kinds,limit:+P.one("limit"),section:+P.one("section"),max:+P.one("max"),tokens:P.tokens,signer:P.one("signer")};
 document.title="emem · "+P.one("say");
 // the page reports its own seal: which files were checked, which were restored from emem, and who sealed them
 const S=globalThis.__seal||{unsealed:true},sealState=h("span",{class:"seal-state"});
 if(S.unsealed)sealState.replaceChildren("unsealed: this page's code was not checked (",h("a",{href:"./emem.eio"},"source"),")");
 else{
  const restored=S.report.filter(r=>r.from.startsWith("emem,")).length,fromEmem=S.report.every(r=>r.from==="emem"),cid=S.url.match(/([a-z2-7]{26})\.md$/)[1];
  sealState.replaceChildren("sealed · ",h("a",{href:S.url,target:"_blank",rel:"noopener",title:"the manifest this page pins; every file it runs is listed there by hash"},`${S.report.length} of ${S.report.length} files checked`),fromEmem?" · all run from emem.dev":restored?` · ${restored} restored from emem, this site's copy did not match`:"");
  resolveToken(cid,spec).then(r=>sealState.append(r.bad?" · ✗ seal signature fails":` · signed by ${S.sealed_by?.slice(0,8)}`)).catch(()=>{});
 }

 const file=h("input",{type:"file",multiple:"",accept:Object.keys(P.kinds).map(e=>"."+e).join(","),hidden:""});
 const box=h("textarea",{placeholder:P.one("in"),rows:"3",spellcheck:"false","aria-label":"what to turn into a link"});
 const go=h("button",{class:"go","aria-label":"make link",title:"make link (Ctrl+Enter)"},"→");
 const drop=h("div",{class:"drop"},box,h("div",{class:"bar"},h("button",{class:"pick",onclick:()=>file.click()},"choose files"),go),file);
 const steps=h("ol",{class:"steps","aria-live":"polite"}),tries=h("div",{class:"tries"});
 const link=h("a",{class:"url"}),meta=h("p",{class:"meta"}),grab=h("button",{class:"grab",hidden:""},"copy link");
 const gives=P.all("give"),tabs=h("div",{class:"tabs",role:"tablist"}),pane=h("div",{class:"pane"});
 const code=h("pre",{class:"code",tabindex:"0"}),copy=h("button",{class:"copy"},"copy");
 const ans=h("textarea",{rows:"5",placeholder:P.one("check"),"aria-label":"answer to check"}),verdict=h("ol",{class:"verdict"}),guarded=h("p",{class:"guard"}),seal=h("button",{class:"seal",hidden:""},"seal this check"),sealed=h("p",{class:"sealed"});
 const pics=h("div",{class:"thumbs"}),out=h("section",{class:"out",hidden:""},h("div",{class:"row"},link,grab),meta,pics,tabs,pane),recent=h("ol",{class:"recent"}),who=h("span");
 const chips=h("div",{class:"chips",role:"toolbar"}),cards=h("div",{class:"cards"}),more=h("button",{class:"more",hidden:""});
 document.body.replaceChildren(
  h("header",{class:"top"},h("a",{class:"brand",href:"./"},h("img",{src:P.one("mark"),alt:"",width:"26",height:"26"}),h("span",{},"emem")),
   h("nav",{"aria-label":"emem"},...P.all("link").map(l=>{const[label,href]=l.arg.split(/\s{2,}/);return h("a",href.startsWith("#")?{href}:{href,target:"_blank",rel:"noopener"},label)}))),
  h("main",{},h("h1",{},P.one("say")),drop,h("p",{class:"note"},P.one("note")),tries,steps,out,recent),
  h("section",{class:"gallery",id:"gallery"},chips,cards,more),
  h("footer",{},who,sealState));

 let run=null,tab=gives[0].arg;
 const vals=()=>({link:run.url,cid:run.cid,title:run.title||"source",shape:run.shape,index:run.body,curl:run.curl,mcp:run.mcp,a2a:run.a2a,verify:run.verify});
 const draw=()=>{
  if(!run){out.hidden=true;return}
  out.hidden=false;
  tabs.replaceChildren(...[...gives.map(g=>g.arg),"check"].map(n=>h("button",{role:"tab","aria-selected":String(n===tab),onclick:()=>{tab=n;draw()}},n)));
  if(tab==="check"){pane.replaceChildren(ans,guarded,verdict,seal,sealed);ans.oninput()}
  else{code.textContent=fill(gives.find(g=>g.arg===tab).body,vals());pane.replaceChildren(code,copy)}
 };
 let last=null,gt=null,pending=null;
 // an answer that cites emem tokens goes to emem-guard: a signed allow or deny, checked here against the pinned key
 const runGuard=async text=>{
  if(!/emem:[a-z]+:\S+/.test(text)){guarded.textContent="";return null}
  try{const g=await guard(text,spec);if(ans.value!==text)return null;if(last?.answer===text)last.guard=g;
   guarded.className="guard "+(g.action==="allow"?"yes":"no");
   guarded.textContent=`emem-guard: ${g.action} · ${g.checked} citation${g.checked===1?"":"s"} checked${g.code?` · ${g.code} (fix: ${g.fix})`:""} · ${g.signed?"verdict signed by emem.dev, checked here":"✗ verdict signature fails"}`;return g}
  catch(e){guarded.className="guard no";guarded.textContent="emem-guard: "+e.message;return null}
 };
 ans.oninput=()=>{
  sealed.textContent="";
  if(!run?.text||!ans.value.trim()){verdict.replaceChildren();guarded.textContent="";seal.hidden=true;return}
  clearTimeout(gt);const text=ans.value;
  if(/emem:[a-z]+:\S+/.test(text)){guarded.className="guard";guarded.textContent="emem-guard: checking the cited tokens…";pending=new Promise(ok=>gt=setTimeout(()=>runGuard(text).then(ok),600))}else{guarded.textContent="";pending=null}
  const src=norm(run.text),q=quotes(ans.value,src),nq=q.filter(x=>found(src,x)).length,g=grounding(ans.value,run.text,!run.token);
  const good=g.traced.filter(t=>t.score>=.6).length,okn=g.numbers.filter(n=>n.ok).length,bad=g.numbers.filter(n=>!n.ok);
  verdict.replaceChildren(
   h("li",{class:"sum"},[q.length?`quotes: ${nq} of ${q.length} are in the source`:"quotes: none",
    g.traced.length?`sentences: ${good} of ${g.traced.length} trace to it word for word (≥60% of their 3-word runs)`:"",
    g.numbers.length?`numbers: ${okn} of ${g.numbers.length} appear in it, in context`:""].filter(Boolean).join("  ·  ")),
   ...q.map(x=>h("li",{class:found(src,x)?"yes":"no"},x)),
   ...bad.map(n=>h("li",{class:"no"},`${n.n} is not in the source next to what this sentence says: ${n.x}`)),
   ...g.traced.filter(t=>t.score<.3).map(t=>h("li",{class:"weak"},`${Math.round(t.score*100)}% traced: ${t.x}`)));
  last={answer:ans.value,guard:null,lines:[...verdict.children].map(li=>(li.className==="yes"?"✓ ":li.className==="no"?"✗ ":li.className==="weak"?"~ ":"")+li.textContent)};
  seal.hidden=false;
 };
 // a check becomes a signed, hash-named file: the answer, the source it was checked against, and every finding; anyone can recompute it
 seal.onclick=async()=>{
  seal.disabled=true;sealed.textContent="sealing…";
  try{
   if(pending)await pending;
   const k=await key(),a=U(last.answer),g=last.guard;
   const body=`---
emem: check.v1
source: ${run.token||run.url}
answer: ${cidOf(a)}
guard: ${g?g.action+(g.code?" "+g.code:""):"none"}
---

# An answer, checked against ${run.title||run.url}

${last.lines[0]||""}
${g?`emem-guard: ${g.action}${g.code?" "+g.code:""} (${g.checked} citations, verdict signed by emem.dev)
`:""}
## Findings

${last.lines.slice(1).map(l=>"- "+l).join("\n")||"- none"}

## The answer

${last.answer.trim()}
`;
   const n=await note(body,k);await put(n,k.pub);
   sealed.replaceChildren("sealed: ",h("a",{href:n.url,target:"_blank",rel:"noopener"},n.url));
  }catch(e){sealed.textContent=e.message}finally{seal.disabled=false}
 };
 grab.onclick=async()=>{try{await navigator.clipboard.writeText(run.url);grab.textContent="copied"}catch{grab.textContent="select and copy"}setTimeout(()=>grab.textContent="copy link",1400)};
 copy.onclick=async()=>{try{await navigator.clipboard.writeText(code.textContent);copy.textContent="copied"}catch{copy.textContent="select and copy"}setTimeout(()=>copy.textContent="copy",1400)};
 const drawRecent=()=>{const list=store("emem.recent")||[];recent.hidden=!list.length;recent.replaceChildren(...(list.length?[h("li",{class:"sum"},"recent")]:[]),
  ...list.map(x=>h("li",{},h("button",{onclick:()=>{box.value=x.url;start(x.url)}},x.title),h("span",{},x.shape))))};
 drawRecent();
 // the key is yours to carry: back it up to a file, restore it in another browser
 const restore=h("input",{type:"file",accept:".json",hidden:""});
 const backup=()=>{const t=exportKey();if(!t)return;const a=h("a",{href:URL.createObjectURL(new Blob([t],{type:"application/json"})),download:`emem-key-${JSON.parse(t).pub_b32.slice(0,8)}.json`});a.click()};
 restore.onchange=async()=>{try{const pub=await importKey(await restore.files[0].text());showKey({pub})}catch(e){who.textContent=e.message}};
 const showKey=k=>who.replaceChildren("key ",h("a",{href:`${EMEM}/memories/by_attester/${k.pub.slice(0,8)}/`,target:"_blank",rel:"noopener",title:"every file this key has stored, listed by emem"},k.pub.slice(0,8))," · ",h("button",{class:"link",onclick:backup},"back up")," · ",h("button",{class:"link",onclick:()=>restore.click()},"restore"),restore);
 key().then(showKey).catch(()=>who.textContent="emem.dev");

 // the latest click wins: an older run keeps going but may no longer touch the page
 let seq=0;const busy=on=>document.querySelector("main").setAttribute("aria-busy",String(on));
 const show=(list,at,sub,bad)=>steps.replaceChildren(...list.map((s,i)=>h("li",{class:i<at?"ok":i===at?(bad?"bad":"now"):""},s+(i===at&&sub?" "+sub:""))));
 const start=async(input,expect,my=++seq)=>{
  const r={spec};let list=P.flows.make;
  if(Array.isArray(input))r.files=input;
  else{r.input=input.trim();if(NOTE.test(r.input))list=P.flows.open;else if(ASK.test(r.input))list=P.flows.ask;else if(tokenType(r.input,P.tokens)||CID.test(r.input)||STH.test(r.input))list=P.flows.resolve}
  if(!r.files?.length&&!r.input){steps.replaceChildren(h("li",{class:"bad"},P.one("blank")));box.focus();busy(false);return}
  let i=0;r.tick=sub=>{if(my===seq)show(list,i,sub)};
  go.disabled=true;busy(true);
  try{
   for(;i<list.length;i++){if(my!==seq)return;show(list,i);await ops[list[i]](r)}
   if(my!==seq)return;
   show(list,i);run=r;tab=gives[0].arg;
   link.textContent=r.url;link.href=r.url;link.target="_blank";link.rel="noopener";grab.hidden=false;
   meta.className="meta"+(r.bad?" bad":"");
   const secs=r.token?0:r.notes?.length??(r.checked.length>1?r.checked.length-1:1),size=r.token?r.shape.split(/\.\s/)[0].replace(/^It is /,"").replace(/\.$/,""):secs>1?`${secs} sections, ${tokens(r.text)}`:tokens(r.text);
   meta.textContent=[r.proof,secs>1?`${size}; the index is ${tokens(r.body)}`:size,r.skipped?.length?`${r.skipped.length} not included`:"",expect&&r.cid===expect?"same file names as the gallery copy":""].filter(Boolean).join("  ·  ");
   if(!r.bad){history.replaceState(null,"","?s="+encodeURIComponent(r.token||r.url));
    store("emem.recent",[{url:r.token||r.url,title:r.title||r.url,shape:size},...(store("emem.recent")||[]).filter(x=>x.url!==(r.token||r.url))].slice(0,8));drawRecent()}
   pics.replaceChildren(...(r.face?.canvases||[]).map(c=>{const d=c.cloneNode();d.getContext("2d").drawImage(c,0,0);return d}));
   draw();
   if(out.getBoundingClientRect().top>innerHeight*.7||out.getBoundingClientRect().top<0)out.scrollIntoView({behavior:"smooth",block:"start"});
  }catch(e){if(my!==seq)return;show(list,i,"",true);run=null;out.hidden=true;steps.append(h("li",{class:"bad err"},e.message||String(e)))}
  finally{if(my===seq){go.disabled=false;busy(false)}}
 };

 // ---------- gallery: real inputs and the links they became, each re-checked as it loads ----------
 // the first eight show at once; a chip shows every card of its kind
 const shows=P.shows,FIRST=8;let filter="all",expanded=false;
 const kinds=["all",...new Set(shows.map(s=>s.kind))];
 const apply=()=>{[...cards.children].forEach((c,i)=>c.hidden=filter!=="all"?c.dataset.kind!==filter:!expanded&&i>=FIRST);more.hidden=filter!=="all"||expanded||cards.children.length<=FIRST;more.textContent=`show all ${cards.children.length}`};
 const drawChips=()=>chips.replaceChildren(...kinds.map(k=>h("button",{"aria-pressed":String(k===filter),onclick:()=>{filter=k;drawChips();apply()}},k)));
 more.onclick=()=>{expanded=true;apply()};
 drawChips();
 const openIt=s=>{box.value=s.emem;scrollTo({top:0,behavior:"smooth"});start(s.emem)};
 const runIt=async s=>{
  scrollTo({top:0,behavior:"smooth"});
  if(s.from.startsWith("./")){const my=++seq;busy(true);const x=await fetch(s.from);const f=new File([await x.blob()],s.from.split("/").pop());if(my!==seq)return;box.value="";start([f],s.cid,my)}
  else{box.value=s.from;start(s.from,s.cid)}
 };
 tries.replaceChildren(...(shows.some(s=>s.pin)?[h("span",{},"try")]:[]),...shows.filter(s=>s.pin).map(s=>h("button",{onclick:()=>openIt(s)},s.pin)));
 // "self" is the seal this page is running from; an unsealed page has none, so the card is left out
 for(const s of shows.filter(s=>s.emem!=="self"||!S.unsealed))if(s.emem==="self")s.emem=S.url;
 for(const s of shows.filter(s=>s.emem!=="self")){
  const state=h("span",{class:"state"},"checking…"),body=h("div",{class:"body"}),live=s.emem==="live";
  s.cid=(s.emem.match(/([a-z2-7]{26})\.md$/)||[])[1];
  const card=h("article",{class:"card",tabindex:"0","data-kind":s.kind,role:"button","aria-label":`open ${s.title}`},
   h("div",{class:"head"},h("span",{class:"tag"},s.tag||s.kind),state),
   h("h3",{},s.title),s.from?h("p",{class:"src"},s.from.replace(/^https?:\/\//,"").replace(/^\.\/samples\//,"sample file · ")):null,body,
   h("div",{class:"acts"},h("span",{},live?"watch":"open"),s.from?h("span",{},"run it yourself"):null));
  card.onclick=e=>{if(live)return;if(e.target.closest(".acts span:nth-child(2)"))runIt(s);else openIt(s)};
  card.onkeydown=e=>{if(e.key==="Enter"&&!live)openIt(s)};
  cards.append(card);
  if(live){const list=h("ol",{class:"feed"});body.replaceChildren(list);state.className="state ok";state.textContent="● live";
   feed(rows=>list.replaceChildren(...rows.map(e=>h("li",{onclick:ev=>{ev.stopPropagation();openIt({emem:`${EMEM}${e.path}`})},title:e.path},h("b",{},String(e.signed_at||"").slice(11,19)),h("b",{},(e.attester_pubkey_b32||"").slice(0,8)),h("span",{},e.path.split("/").slice(4).join("/")))))).catch(()=>{state.className="state bad";state.textContent="offline"});
   continue}
  summarize(s,spec).then(x=>{state.className="state "+(x.ok?"ok":"bad");state.textContent=x.state;
   body.replaceChildren(...x.nodes.map(([cls,t])=>cls==="canvas"?h("div",{class:"thumbs"},...t):h(cls==="peek"?"pre":"p",{class:cls},t)))})
   .catch(e=>{state.className="state bad";state.textContent="unreachable";body.replaceChildren(h("p",{class:"stat"},e.message))});
 }

 apply();

 go.onclick=()=>start(box.value);
 box.onkeydown=e=>{if(e.key==="Enter"&&(e.metaKey||e.ctrlKey))start(box.value)};
 box.onpaste=e=>{const f=[...(e.clipboardData?.files||[])];if(f.length){e.preventDefault();start(f)}};
 file.onchange=()=>{start([...file.files]);file.value=""};
 // a file dropped anywhere on the page is read, never opened by the browser
 addEventListener("dragover",e=>{e.preventDefault();drop.dataset.over=""});
 addEventListener("dragleave",e=>{if(!e.relatedTarget)delete drop.dataset.over});
 addEventListener("drop",e=>{e.preventDefault();delete drop.dataset.over;const f=[...(e.dataTransfer?.files||[])];if(f.length)start(f)});
 const q=new URLSearchParams(location.search).get("s");if(q){box.value=q;start(q)}
};
boot().catch(e=>document.body.replaceChildren(document.createTextNode("emem.eio: "+e.message)));
