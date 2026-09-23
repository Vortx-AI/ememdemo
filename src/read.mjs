// read.mjs: any input becomes markdown with real headings, then sections an agent can fetch one at a time.
const NPM="https://cdn.jsdelivr.net/npm/";
const LIB={
 pdf:NPM+"pdfjs-dist@4.10.38/build/pdf.min.mjs",
 pdfWorker:NPM+"pdfjs-dist@4.10.38/build/pdf.worker.min.mjs",
 mammoth:NPM+"mammoth@1.8.0/mammoth.browser.min.js",
 xlsx:NPM+"xlsx@0.18.5/dist/xlsx.full.min.js",
 jszip:NPM+"jszip@3.10.1/dist/jszip.min.js",
 ocr:NPM+"tesseract.js@5.1.1/dist/tesseract.esm.min.js",
};
const READER="https://r.jina.ai/";

import {net} from "./emem.mjs";

// ---------- plumbing ----------
const loaded={};
const script=(src,global)=>loaded[src]??=new Promise((ok,no)=>{const s=document.createElement("script");s.src=src;s.onload=()=>ok(window[global]);s.onerror=()=>no(new Error("Could not load a reader from cdn.jsdelivr.net. Check your connection."));document.head.append(s)});
export const ext=n=>(n.match(/\.([a-z0-9]+)$/i)?.[1]||"").toLowerCase();
const one=s=>String(s??"").replace(/\s+/g," ").trim();
const tidy=s=>s.replace(/\r\n?/g,"\n").replace(/\u00a0/g," ").replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
const heading=(d,t)=>`\n${"#".repeat(Math.min(6,Math.max(1,d)))} ${one(t)}\n`;
const alnum=s=>s.toLowerCase().replace(/[^a-z0-9]/g,"");
const MARK=/^\[page \d+\]$/;

// ---------- headings in plain text ----------
const NUM=/^((?:\d{1,3}\.)*\d{1,3}\.?|[A-Z]\.(?:\d{1,3}\.?)*|Appendix\s+[A-Z]\.?)\s{1,4}(\S.{1,80})$/;
const numbered=line=>{
 const s=line.trim(),m=s.match(NUM);if(!m||s.length>90)return 0;
 const t=m[2];if(/\.{4,}|[.,;]$|\s\d+$/.test(t))return 0;                                   // contents leaders, sentences
 const depth=m[1].replace(/^Appendix\s+/,"").split(".").filter(Boolean).length,letters=(t.match(/[A-Za-z]/g)||[]).length,chars=t.replace(/\s/g,"").length;
 if(depth>=2?letters<2||letters<chars*.25:letters<3||letters<chars*.55||!/^[A-Z0-9"'(“]/.test(t))return 0;  // table rows, list items
 return Math.min(6,depth);
};

// running headers, footers and page numbers repeat at page edges; drop them
const stripRunning=(pages,get=x=>x)=>{
 if(pages.length<4)return pages;
 const key=l=>{const t=one(get(l));return MARK.test(t)?"":t.replace(/\d+/g,"#").toLowerCase()};
 const edges=p=>{const idx=p.map((l,i)=>one(get(l))?i:-1).filter(i=>i>=0);return new Set([...idx.slice(0,2),...idx.slice(-2)])};
 const count=new Map();
 for(const p of pages)for(const i of edges(p)){const k=key(p[i]);if(k)count.set(k,(count.get(k)||0)+1)}
 const min=Math.max(3,pages.length*.3);
 return pages.map(p=>{const e=edges(p);return p.filter((l,i)=>!(e.has(i)&&count.get(key(l))>=min))});
};

const textMd=t=>{
 const lines=stripRunning(tidy(t).split("\f").map(p=>p.split("\n"))).flat(),out=[];
 for(let i=0;i<lines.length;i++){
  const l=lines[i],next=lines[i+1]??"",u=next.match(/^([=\-~^*#])\1{2,}\s*$/);
  if(u&&l.trim()&&!/^\s/.test(l)&&Math.abs(next.trim().length-l.trim().length)<=3){out.push(heading(u[1]==="="||u[1]==="#"?1:u[1]==="-"?2:3,l));i++;continue}
  const d=!/^\s/.test(l)&&(i===0||!lines[i-1].trim())?numbered(l):0;
  out.push(d?heading(d,l):l);
 }
 return out.join("\n");
};

// ---------- HTML (files, docx, epub) ----------
const BLOCK=/^(H[1-6]|P|LI|PRE|TR|BLOCKQUOTE|DT|DD|FIGCAPTION|CAPTION|DIV|SECTION|ARTICLE|MAIN|UL|OL|TABLE|TBODY|THEAD|TFOOT|BODY|ASIDE|DL|FIGURE|HEADER|FOOTER|NAV|FORM|FIELDSET|DETAILS|SUMMARY|CENTER|HR|BR)$/;
const htmlMd=html=>{
 const d=new DOMParser().parseFromString(html,"text/html");
 d.querySelectorAll("script,style,noscript,svg,template,iframe,nav").forEach(e=>e.remove());
 const out=[],emit=el=>{
  const tag=el.tagName;
  if(/^H[1-6]$/.test(tag)){const t=one(el.textContent);if(t)out.push(heading(+tag[1],t));return}
  if(tag==="PRE"){out.push("\n```\n"+el.textContent.replace(/\n$/,"")+"\n```\n");return}
  if(tag==="TR"){out.push("| "+[...el.children].map(c=>one(c.textContent)).join(" | ")+" |");return}
  if(tag==="HR"||tag==="BR")return;
  let run="";const li=tag==="LI"?"- ":"",flush=()=>{const t=one(run);if(t)out.push(li+t+(li?"":"\n"));run=""};
  for(const c of el.childNodes){if(c.nodeType===1&&BLOCK.test(c.tagName)){flush();emit(c)}else if(c.nodeType===1||c.nodeType===3)run+=c.textContent}
  flush();
 };
 if(d.body)emit(d.body);
 return{title:one(d.title)||one(d.querySelector("h1")?.textContent),md:out.join("\n")};
};

// ---------- PDF ----------
const pdfLib=async()=>{const pdf=await import(LIB.pdf);pdf.GlobalWorkerOptions.workerPort??=new Worker(URL.createObjectURL(new Blob([`import "${LIB.pdfWorker}";`],{type:"text/javascript"})),{type:"module"});return pdf};

// the PDF's own bookmarks are the most reliable headings; a single wrapper root is unwrapped
const outlineMarks=async doc=>{
 let roots=await doc.getOutline().catch(()=>null);if(!roots?.length)return null;
 if(roots.length<=2&&roots.some(o=>o.items?.length))roots=roots.flatMap(o=>o.items||[]);
 const flat=[],walk=async(items,d)=>{for(const it of items){
  let page=null;try{const dest=typeof it.dest==="string"?await doc.getDestination(it.dest):it.dest;if(Array.isArray(dest))page=typeof dest[0]==="number"?dest[0]:await doc.getPageIndex(dest[0])}catch{}
  if(page!=null&&one(it.title))flat.push({title:one(it.title),depth:d,page});
  if(it.items?.length&&d<4)await walk(it.items,d+1)}};
 await walk(roots,1);
 if(flat.length<3)return null;
 const m=new Map();for(const f of flat){if(!m.has(f.page))m.set(f.page,[]);m.get(f.page).push(f)}return m;
};

const pdfDoc=async(buf,name,tick)=>{
 const pdf=await pdfLib(),doc=await pdf.getDocument({data:new Uint8Array(buf)}).promise;
 let pages=[];
 for(let p=1;p<=doc.numPages;p++){
  const c=await(await doc.getPage(p)).getTextContent(),lines=[];let cur=null;
  for(const it of c.items){cur??={t:"",h:0,y:it.transform?.[5]??0};cur.t+=it.str;cur.h=Math.max(cur.h,it.height||0);if(it.hasEOL){lines.push(cur);cur=null}}
  if(cur)lines.push(cur);
  pages.push(lines.filter(l=>l.t.trim()));
  tick(`page ${p}/${doc.numPages}`);
 }
 const chars=pages.reduce((n,p)=>n+p.reduce((m,l)=>m+l.t.trim().length,0),0);
 if(chars<doc.numPages*40)return ocrPdf(doc,name,tick);

 const hs={};for(const p of pages)for(const l of p)hs[Math.round(l.h)]=(hs[Math.round(l.h)]||0)+l.t.length;
 const body=+Object.entries(hs).sort((a,b)=>b[1]-a[1])[0][0]||10;
 const meta=await doc.getMetadata().catch(()=>null);
 let title=one(meta?.info?.Title);
 if(!title||/^(untitled|microsoft word|document\d*$)|\.(docx?|pdf|tex|dvi)$/i.test(title)){
  const top=pages[0].slice(0,15),max=Math.max(0,...top.map(l=>l.h));
  const big=top.filter(l=>l.h>=max-.5&&max>=body*1.3).slice(0,2).map(l=>l.t).join(" ");
  title=big.length>3&&big.length<160?one(big):name;
 }
 pages=stripRunning(pages,l=>l.t);
 const marks=await outlineMarks(doc);
 const sizes=[...new Set(pages.flat().filter(l=>l.h>=body*1.2&&l.t.length<=90).map(l=>Math.round(l.h)))].sort((a,b)=>b-a);
 const out=[];
 pages.forEach((lines,pi)=>{
  out.push(`\n[page ${pi+1}]`);
  const at=new Map(),insert=new Map();let cursor=0;
  for(const m of marks?.get(pi)||[]){
   const want=alnum(m.title);let hit=-1;
   for(let i=cursor;i<lines.length;i++){const have=alnum(lines[i].t);if(have&&(have===want||(have.endsWith(want)&&have.length<=want.length+12)||(want.length>8&&have.startsWith(want)&&have.length<=want.length+6))){hit=i;break}}
   if(hit>=0){at.set(hit,m.depth);cursor=hit+1}else{if(!insert.has(cursor))insert.set(cursor,[]);insert.get(cursor).push(m)}
  }
  lines.forEach((l,i)=>{
   for(const m of insert.get(i)||[])out.push(heading(m.depth,m.title));
   const d=at.get(i)??(marks?0:numbered(l.t)||(l.h>=body*1.2&&l.t.length<=90&&/[A-Za-z]{3}/.test(l.t)?Math.min(3,sizes.indexOf(Math.round(l.h))+1):0));
   if(d)out.push(heading(d,l.t));
   else{if(i&&lines[i-1].y-l.y>1.8*(l.h||body))out.push("");out.push(l.t)}
  });
  for(const m of insert.get(lines.length)||[])out.push(heading(m.depth,m.title));
 });
 return{title,md:out.join("\n"),what:`${doc.numPages}-page PDF`};
};

// ---------- OCR: images and scans ----------
let OCR;
const ocr=()=>OCR??=import(LIB.ocr).then(T=>(T.createWorker||T.default.createWorker)("eng",1,{
 workerPath:NPM+"tesseract.js@5.1.1/dist/worker.min.js",corePath:NPM+"tesseract.js-core@5.1.1",langPath:NPM+"@tesseract.js-data/eng@1.0.0/4.0.0_best_int"}));
const ocrPdf=async(doc,name,tick)=>{
 const n=Math.min(doc.numPages,40),w=await ocr(),pages=[];
 for(let p=1;p<=n;p++){
  tick(`reading scan ${p}/${n}`);
  const page=await doc.getPage(p),vp=page.getViewport({scale:2}),cv=document.createElement("canvas");cv.width=vp.width;cv.height=vp.height;
  await page.render({canvasContext:cv.getContext("2d"),viewport:vp}).promise;
  pages.push(`[page ${p}]\n`+(await w.recognize(cv)).data.text);
 }
 const md=textMd(pages.join("\f"));
 if(!md.replace(/\[page \d+\]/g,"").trim())throw new Error(`${name}: no readable text, even with OCR.`);
 return{title:name,md,what:`scanned ${doc.numPages}-page PDF, read by OCR${doc.numPages>n?` (first ${n} pages)`:""}`};
};
const imageDoc=async(file,name,tick)=>{
 tick("reading image text");
 const bmp=await createImageBitmap(file),cv=document.createElement("canvas");cv.width=bmp.width;cv.height=bmp.height;
 const g=cv.getContext("2d");g.drawImage(bmp,0,0);
 // OCR reads dark text on light; light-on-dark images (terminals, dark mode) are inverted first
 const px=g.getImageData(0,0,cv.width,cv.height),d=px.data;let sum=0,n=0;
 for(let i=0;i<d.length;i+=4*97){sum+=d[i]*.3+d[i+1]*.59+d[i+2]*.11;n++}
 if(sum/n<110){for(let i=0;i<d.length;i+=4){d[i]=255-d[i];d[i+1]=255-d[i+1];d[i+2]=255-d[i+2]}g.putImageData(px,0,0)}
 const text=(await(await ocr()).recognize(cv)).data.text;
 if(!text.trim())throw new Error(`${name}: no text found in the image.`);
 return{title:name,md:textMd(text),what:"image, text read by OCR"};
};

// ---------- office and books ----------
const zip=async buf=>(await script(LIB.jszip,"JSZip")).loadAsync(buf);
const xml=s=>new DOMParser().parseFromString(s,"application/xml");
const docxDoc=async buf=>{const m=await script(LIB.mammoth,"mammoth"),h=htmlMd((await m.convertToHtml({arrayBuffer:buf},{styleMap:["p[style-name='Title'] => h1:fresh","p[style-name='Subtitle'] => h2:fresh"]})).value);return{title:h.title,md:h.md,what:"Word document"}};
const xlsxDoc=async buf=>{
 const X=await script(LIB.xlsx,"XLSX"),wb=X.read(buf,{type:"array"});
 return{md:wb.SheetNames.map(n=>heading(1,"Sheet: "+n)+"\n"+X.utils.sheet_to_csv(wb.Sheets[n],{blankrows:false})).join("\n"),what:`spreadsheet, ${wb.SheetNames.length} sheet${wb.SheetNames.length>1?"s":""}`};
};
const pptxDoc=async buf=>{
 const z=await zip(buf),num=p=>+p.match(/(\d+)\.xml$/)[1];
 const slides=Object.keys(z.files).filter(p=>/^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a,b)=>num(a)-num(b));
 const paras=async p=>z.file(p)?[...xml(await z.file(p).async("string")).getElementsByTagName("a:p")].map(n=>one([...n.getElementsByTagName("a:t")].map(t=>t.textContent).join(""))).filter(Boolean):[];
 const out=[];
 for(const s of slides){const n=num(s),[first="",...rest]=await paras(s),notes=(await paras(`ppt/notesSlides/notesSlide${n}.xml`)).filter(t=>!/^\d+$/.test(t));
  out.push(heading(2,`Slide ${n}${first?": "+first:""}`),rest.join("\n"),notes.length?"\nNotes: "+notes.join(" "):"")}
 return{md:out.join("\n"),what:`slide deck, ${slides.length} slides`};
};
const epubDoc=async buf=>{
 const z=await zip(buf),opfPath=xml(await z.file("META-INF/container.xml").async("string")).querySelector("rootfile")?.getAttribute("full-path");
 const opf=xml(await z.file(opfPath).async("string")),base=opfPath.replace(/[^/]*$/,"");
 const items=Object.fromEntries([...opf.getElementsByTagName("item")].map(i=>[i.getAttribute("id"),i.getAttribute("href")]));
 const out=[];
 for(const r of opf.getElementsByTagName("itemref")){const f=z.file(base+decodeURIComponent(items[r.getAttribute("idref")]||""));if(f)out.push(htmlMd(await f.async("string")).md)}
 return{title:one(opf.getElementsByTagName("dc:title")[0]?.textContent),md:out.join("\n"),what:`e-book, ${out.length} chapters`};
};

// ---------- one input, one document ----------
// kind: "prose" is parsed for headings; "code" is kept whole, because "#" there is a comment, not a heading
export const toDoc=async(it,kinds,tick)=>{
 const name=it.name,e=ext(name),kind=kinds[e];
 if(it.text!=null)return{name,title:"",md:tidy(it.text),kind:"prose",what:"pasted text"};
 if(it.remote)return webDoc(it.remote,kinds,tick);
 if(!kind)throw new Error(`${name}: ${/^(mp3|wav|m4a|ogg|flac|mp4|mov|webm|mkv|avi)$/.test(e)?"audio and video are not read yet":`.${e||"?"} files are not read`}.`);
 let buf;if(it.file)buf=await it.file.arrayBuffer();else{const x=await net(it.url);if(!x.ok)throw new Error(`${name}: could not be fetched (${x.status}).`);buf=await x.arrayBuffer()}
 let d;
 if(e==="pdf")d=await pdfDoc(buf,name,tick);
 else if(e==="docx")d=await docxDoc(buf);
 else if(e==="xlsx")d=await xlsxDoc(buf);
 else if(e==="pptx")d=await pptxDoc(buf);
 else if(e==="epub")d=await epubDoc(buf);
 else if(kind==="images")d=await imageDoc(it.file||new Blob([buf]),name,tick);
 else{
  const t=new TextDecoder().decode(buf);
  if(e==="html"||e==="htm"){const h=htmlMd(t);d={title:h.title,md:h.md,what:"web page file"}}
  else if(e==="md"||e==="mdx")d={title:(t.match(/^#\s+(.+)$/m)||[])[1]||"",md:tidy(t),what:"markdown"};
  else if(kind==="docs")d={md:textMd(t),what:"text file"};
  else return{name,title:name,md:t.replace(/\r\n?/g,"\n"),kind:"code",what:kind==="data"?"data file":"code file"};
 }
 return{name,title:one(d.title),md:d.md,kind:"prose",what:d.what};
};

// a file served with open CORS is read here by the same readers as a dropped file;
// a web page goes through a reader that returns markdown, whose preamble is metadata, not content
const TYPES={"application/pdf":"pdf","text/plain":"txt","text/markdown":"md","text/csv":"csv","application/json":"json","application/epub+zip":"epub",
 "application/vnd.openxmlformats-officedocument.wordprocessingml.document":"docx","application/vnd.openxmlformats-officedocument.presentationml.presentation":"pptx",
 "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":"xlsx","image/png":"png","image/jpeg":"jpg","image/webp":"webp"};
const webDoc=async(url,kinds,tick)=>{
 tick("reading link");
 const direct=await fetch(url).catch(()=>null);
 if(direct?.ok){
  const type=(direct.headers.get("content-type")||"").split(";")[0].trim().toLowerCase(),u=new URL(url);
  const pe=ext(u.pathname),e=kinds[pe]?pe:TYPES[type]||"";
  if(e&&kinds[e]){
   const base=decodeURIComponent(u.pathname.split("/").filter(Boolean).pop()||u.host),name=ext(base)===e?base:`${base}.${e}`;
   const d=await toDoc({name,file:new File([await direct.blob()],name)},kinds,tick);
   return{...d,what:`${d.what} from ${u.host}`};
  }
 }
 const x=await net(READER+url);if(!x.ok)throw new Error(`Could not read ${url} (${x.status}).`);
 const t=await x.text(),at=t.indexOf("Markdown Content:");
 const title=one((t.match(/^Title:\s*(.+)$/m)||[])[1]);
 return{name:url,title,md:tidy(at>=0?t.slice(at+17):t),kind:"prose",what:`web page ${url.replace(/^https?:\/\//,"")}`};
};

// ---------- GitHub repos, listed and served by jsDelivr (no rate limit), pinned to a commit when GitHub answers ----------
export const REPO=/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(tree|blob)\/([^/\s]+)(\/[^\s]*)?)?\/?$/;
export const repoItems=async(m,kinds,budget)=>{
 const[,o,n,mode,ref,sub=""]=m;
 const api=p=>net(`https://api.github.com/repos/${o}/${n}${p}`).then(x=>x.ok?x.json():null).catch(()=>null);
 let branch=ref;if(!branch)branch=(await api(""))?.default_branch;
 const sha=(await api(`/commits/${encodeURIComponent(branch||"HEAD")}`))?.sha;
 let list=null,ver=null;
 for(const v of [sha,branch,"main","master"].filter(Boolean)){const x=await net(`https://data.jsdelivr.com/v1/packages/gh/${o}/${n}@${encodeURIComponent(v)}?structure=flat`);if(x.ok){list=(await x.json()).files;ver=v;break}}
 if(!list)throw new Error(`Could not list github.com/${o}/${n}. It may be private, missing, or over 150 MB.`);
 const cdn=p=>`https://cdn.jsdelivr.net/gh/${o}/${n}@${encodeURIComponent(ver)}${p.split("/").map(encodeURIComponent).join("/")}`;
 const label=`github.com/${o}/${n}${sub}`,at=ver===sha?`commit ${sha.slice(0,12)}`:`branch ${ver}`;
 if(mode==="blob")return{name:label,items:[{name:sub.slice(1),url:cdn(sub)}],what:`file ${label} at ${at}`};
 const SKIP=/(^|\/)(node_modules|dist|build|out|vendor|third_party|\.git|\.next|target|coverage|__pycache__|\.venv)\//i;
 const LOCK=/(\.min\.|\.map$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock)$)/i;
 const rank=p=>/^\/readme(\.\w+)?$/i.test(p)?0:/(^|\/)(history|changelog|changes|news|releases?)(\.\w+)?$/i.test(p)?4:/^\/readme/i.test(p)||/(^|\/)docs?\//i.test(p)&&/\.(md|mdx|rst|txt)$/i.test(p)?1:/\.(md|mdx|rst)$/i.test(p)?2:/(^|\/)(tests?|__tests__|spec|fixtures?|examples?|benchmarks?)\//i.test(p)?4:kinds[ext(p)]==="data"?5:3;
 const files=list.filter(f=>f.name.startsWith(sub||"/")&&f.size<400000&&kinds[ext(f.name)]&&kinds[ext(f.name)]!=="images"&&!SKIP.test(f.name)&&!LOCK.test(f.name))
  .sort((a,b)=>rank(a.name)-rank(b.name)||a.name.localeCompare(b.name));
 if(!files.length)throw new Error(`No readable text files in ${label}.`);
 let total=0;const pick=[];for(const f of files){if(total+f.size>budget||pick.length>=900)break;total+=f.size;pick.push(f)}
 pick.sort((a,b)=>rank(a.name)-rank(b.name)||a.name.localeCompare(b.name));
 const left=files.length-pick.length;
 return{name:label,items:pick.map(f=>({name:f.name.slice(1),url:cdn(f.name)})),
  what:`${label} at ${at}, ${pick.length} of ${files.length} text files${left?` (the other ${left} are over the size cap; paste a folder URL to narrow)`:""}`};
};

// ---------- blocks: one per heading ----------
const ATX=/^(#{1,6})\s+(.+?)\s*#*\s*$/;
const cleanTitle=t=>one(t.replace(/!\[[^\]]*\]\([^)]*\)/g,"").replace(/\[([^\]]*)\]\([^)]*\)/g,"$1").replace(/[¶*_`]/g,"").replace(/\\([\\`*_{}\[\]()#+\-.!])/g,"$1")).slice(0,100);
const setext=lines=>{
 const o=[...lines];let fence=false,i=0;
 if(/^---\s*$/.test(o[0]||"")){i=o.findIndex((l,k)=>k>0&&/^---\s*$/.test(l));if(i<0)i=0}
 for(i++;i<o.length;i++){
  if(/^\s*(```|~~~)/.test(o[i-1]))fence=!fence;
  const u=!fence&&o[i].match(/^(=+|-{3,})\s*$/);
  if(u&&o[i-1].trim()&&!ATX.test(o[i-1])&&!/^\s*([-*+>|]|\d+\.)\s/.test(o[i-1])&&!/^\s/.test(o[i-1])){o[i-1]=(u[1][0]==="="?"# ":"## ")+o[i-1].trim();o[i]=""}
 }
 return o;
};
const SYM=new RegExp([
 String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:function\*?|class|def|fn|func|interface|type|struct|enum|trait|module|object)\s+([A-Za-z_$][\w$]*)`,
 String.raw`^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[\w$]+\s*=>)`,
 String.raw`^([A-Za-z_$][\w$]*(?:\.[\w$]+)+)\s*=\s*(?:async\s+)?function`].join("|"),"gm");
const symbols=t=>[...new Set([...t.matchAll(SYM)].map(m=>m[1]||m[2]||m[3]))].slice(0,10);
const real=t=>t.replace(/\[page \d+\]/g,"").trim();

export const blocksOf=(doc,multi)=>{
 const root=multi?doc.name:doc.title||doc.name;
 if(doc.kind==="code")return[{doc:doc.name,title:doc.name,depth:1,text:doc.md.replace(/\n*$/,"\n"),code:true,sym:symbols(doc.md)}];
 const out=[];let cur={doc:doc.name,title:root,depth:0,text:""},fence=false,carry="";
 for(const l of setext(doc.md.split("\n"))){
  if(/^\s*(```|~~~)/.test(l))fence=!fence;
  const m=!fence&&l.match(ATX);
  if(m){if(real(cur.text))out.push(cur);else carry=cur.text;cur={doc:doc.name,title:cleanTitle(m[2])||root,depth:m[1].length,text:carry};carry=""}
  cur.text+=l+"\n";
 }
 if(real(cur.text))out.push(cur);
 return out;
};

// ---------- sections: blocks packed in order, breaking at top-level headings and file boundaries ----------
const chop=(b,max)=>{
 const parts=b.text.split(b.code?/(?<=\n)/:/(?<=\n\n)/),out=[];let buf="";
 for(let p of parts){
  while(p.length>max){if(buf){out.push(buf);buf=""}out.push(p.slice(0,max));p=p.slice(max)}
  if(buf&&buf.length+p.length>max){out.push(buf);buf=""}
  buf+=p;
 }
 if(buf)out.push(buf);
 return out.map((t,i)=>({...b,text:t,title:out.length>1?`${b.title} (part ${i+1} of ${out.length})`:b.title,sym:i?[]:b.sym}));
};
export const pack=(blocks,max)=>{
 const out=[];let cur=null;
 for(const b of blocks)for(const p of b.text.length>max?chop(b,max):[b]){
  const size=cur?cur.text.length:0;
  if(cur&&(size+p.text.length>max||(size>max*.5&&(p.depth===1||p.doc!==cur.blocks.at(-1).doc))))cur=null;
  if(!cur)out.push(cur={blocks:[],text:""});
  cur.blocks.push(p);cur.text+=p.text;
 }
 return out;
};

// what an agent needs to pick a section without opening it: its title, pages, and the headings or symbols inside
const commonDir=docs=>{const parts=docs.map(d=>d.split("/").slice(0,-1));let n=0;while(parts.every(p=>n<p.length&&p[n]===parts[0][n]))n++;return n?parts[0].slice(0,n).join("/")+"/":""};
export const describe=(sections,multi,total=40000)=>{
 let page=1;
 const rows=sections.map(s=>{
  const marks=[...s.text.matchAll(/\[page (\d+)\]/g)].map(m=>+m[1]);
  const from=/^\s*(#[^\n]*\n\s*)?\[page \d+\]/.test(s.text)&&marks.length?marks[0]:page,to=marks.length?marks.at(-1):page;page=to;
  const pages=marks.length||page>1?` · ${from===to?`p. ${from}`:`pp. ${from}–${to}`}`:"";
  const docs=[...new Set(s.blocks.map(b=>b.doc))],sym=b=>b.code&&b.sym?.length?` (${b.sym.join(", ")})`:"";
  const label=(b,i)=>(multi&&(i===0||b.doc!==s.blocks[i-1].doc)&&!b.title.startsWith(b.doc)?`${b.doc} · `:"")+b.title;
  if(multi&&docs.length>1)return{title:(commonDir(docs)?`${commonDir(docs)} · ${docs.length} files`:`${docs[0]} + ${docs.length-1} more file${docs.length>2?"s":""}`)+pages,covers:s.blocks.map((b,i)=>label(b,i)+sym(b))};
  const[first,...rest]=s.blocks,covers=rest.map((b,i)=>label(b,i+1)+sym(b));
  if(first.code&&first.sym?.length)covers.unshift(first.sym.join(", "));
  if(!covers.length&&!first.code){const b=one(real(first.text).replace(/^#+\s.*$/m,"")).slice(0,110);return{title:label(first,0)+pages,covers:b?`begins "${b}${b.length>=110?"…":""}"`:""}}
  return{title:label(first,0)+pages,covers};
 });
 const len=r=>Array.isArray(r.covers)?r.covers.join("; ").length:0,sum=rows.reduce((n,r)=>n+len(r),0);
 return rows.map(r=>{
  if(!Array.isArray(r.covers))return r;
  const budget=sum>total?Math.max(300,Math.floor(len(r)*total/sum)):Infinity;let t="",n=0;
  for(const c of r.covers){if(t&&t.length+c.length+2>budget)break;t+=(t?"; ":"")+c;n++}
  return{title:r.title,covers:n<r.covers.length?`${t}; +${r.covers.length-n} more`:t};
 });
};
