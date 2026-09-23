// tools/seal.mjs: seals the site. Run after any change:  EMEM_KEY_FILE=path/to/site-key.json node tools/seal.mjs
//
// 1. compiles the agent interface (llms.txt, .well-known/agent-card.json) from emem.eio
// 2. stores every file the page runs on emem, each named by the hash of its bytes, signed by the site key
// 3. stores a manifest listing them (path, sha256, emem link) and every third-party library the page may load (url, sha256)
// 4. pins the manifest's link and sha256 into index.html, whose loader checks every file before running it
//
// The key file ({priv,pub} base64, as a browser backup writes it) is never committed.
import fs from "fs";
import "../src/vendor/emem-verify-core.js";
import {compile} from "../src/lang.mjs";

const EMEM="https://emem.dev",ROOT=new URL("..",import.meta.url).pathname;
const blake3=globalThis.ememCrypto.blake3,U=s=>new TextEncoder().encode(s);
const A="abcdefghijklmnopqrstuvwxyz234567",b32=u=>{let b=0,v=0,o="";for(const x of u){v=(v<<8)|x;b+=8;while(b>=5){o+=A[(v>>>(b-5))&31];b-=5}}if(b>0)o+=A[(v<<(5-b))&31];return o};
const cat=(...a)=>{const r=new Uint8Array(a.reduce((n,x)=>n+x.length,0));let i=0;for(const x of a){r.set(x,i);i+=x.length}return r};
const sha256=async b=>Buffer.from(await crypto.subtle.digest("SHA-256",b)).toString("hex");
const read=p=>fs.readFileSync(ROOT+p,"utf8");

const kf=process.env.EMEM_KEY_FILE;if(!kf)throw new Error("set EMEM_KEY_FILE to the site key backup");
const kj=JSON.parse(fs.readFileSync(kf,"utf8"));
const priv=await crypto.subtle.importKey("pkcs8",Buffer.from(kj.priv,"base64"),{name:"Ed25519"},false,["sign"]),pub=b32(new Uint8Array(Buffer.from(kj.pub,"base64")));

// ---------- 1. the agent interface, compiled from the same source as the page ----------
const src=read("emem.eio"),P=compile(src);
const shows=P.shows.filter(s=>s.emem&&s.emem!=="live");
const rows=Object.entries(P.tokens);
fs.writeFileSync(ROOT+"llms.txt",`# ememdemo: ${P.one("say")}

> A website with no server. Everything it does is a call to emem.dev that an agent can make itself, listed below. This file is compiled from emem.eio by tools/seal.mjs and sealed with the site: its sha256 is in the manifest that index.html pins.

## Do what this page does, directly

- **Turn text into a link.** Store it as a note named by its hash: path \`/memories/by_attester/<first 8 of your ed25519 key, base32>/<base32(blake3(bytes)[0:16])>.md\`. Sign \`blake3("emem.memory_write.v2|create|" + path + "|" + blake3(bytes) + "|absent")\` and \`POST ${EMEM}/a2a/tasks {"skill":"emem_memory_create","args":{"path","file_text","kind":"resource","attester":{"pubkey_b32","sig_b32"}}}\`. Split long text into sections of ~6k tokens, store each, then store an index that links them; the index's name then commits to every section.
- **Read and check a link.** \`GET\` it; base32(blake3(bytes)[0:16]) must equal the file name. Or read it by name alone: \`POST ${EMEM}/a2a/tasks {"skill":"emem_memory_view","args":{"file_cid":"<name>"}}\`.
- **Name large data where it lives.** Read the source's structure by byte range (COG tiles, OME-Zarr chunks, HLS segments, safetensors tensors, DICOM pixel blocks, or 4 MiB ranges), hash each chunk you read with BLAKE3-256, and store only a pointer note (\`emem: pointer.v1\`): source URL, size, one table row per chunk (url, offset, length, hash), and a Merkle root over the rows (a hash chain for video segments). To use it, read a row's byte range from the source and compare hashes. The data never goes to emem.
- **Check an answer's citations.** \`POST ${EMEM}/a2a/tasks {"skill":"emem_guard_verdict","args":{"texts":["<answer>"]}}\` returns a signed allow or deny with a reason code.
- **Ask about a place.** \`POST ${EMEM}/v1/ask {"q":"flood risk in Chennai"}\`; add \`Accept: text/event-stream\` for stages.

## The token family

| token | what it is | read it over HTTP | MCP tool / A2A skill |
|---|---|---|---|
${rows.map(([k,r])=>`| emem:${k} | ${r.what} | ${r.method} ${EMEM}${r.path}${r.body?" "+r.body:""} | ${r.tool==="-"?"none":r.tool} |`).join("\n")}

Every receipt must verify against the key ${P.one("signer")}.

## Worked examples (each re-checked by the page as it loads)

${shows.map(s=>`- ${s.title}: ${s.emem}${s.from?` (from ${s.from})`:""}`).join("\n")}
`);
const card={name:"ememdemo",description:`${P.one("say")} A static page over emem.dev; these skills run at emem.dev's A2A endpoint.`,
 url:`${EMEM}/a2a/tasks`,version:b32(blake3(U(src)).slice(0,16)),provider:{organization:"Vortx AI",url:"https://vortx.ai"},
 documentationUrl:"https://github.com/Vortx-AI/ememdemo",defaultInputModes:["application/json"],defaultOutputModes:["application/json"],capabilities:{streaming:false},
 skills:[
  {id:"emem_memory_create",name:"store a link",description:"Store text as a signed note named by the hash of its bytes.",tags:["write","link"]},
  {id:"emem_memory_view",name:"read a link by name",description:"Read a note by its file name (the hash of its bytes), with its author's signature.",tags:["read","verify"]},
  {id:"emem_guard_verdict",name:"check an answer",description:"Resolve every emem: citation in a text and return a signed allow or deny with a reason code.",tags:["verify"]},
  {id:"emem_ask",name:"ask about a place",description:"A signed answer about a real place, with the facts it used.",tags:["earth","answer"]},
  ...rows.filter(([,r])=>r.tool!=="-").map(([k,r])=>({id:r.tool,name:`resolve emem:${k}`,description:r.what,tags:["token"]}))]};
fs.mkdirSync(ROOT+".well-known",{recursive:true});
fs.writeFileSync(ROOT+".well-known/agent-card.json",JSON.stringify(card,null,1)+"\n");

// ---------- 2. every file the page runs, stored on emem by its hash ----------
const put=async(path,body)=>{
 const bytes=U(body),d=blake3(cat(U(`emem.memory_write.v2|create|${path}|`),blake3(bytes),U("|absent")));
 const sig=b32(new Uint8Array(await crypto.subtle.sign("Ed25519",priv,d)));
 const x=await fetch(`${EMEM}/a2a/tasks`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({skill:"emem_memory_create",args:{path,file_text:body,kind:"resource",attester:{pubkey_b32:pub,sig_b32:sig}}})});
 if(x.ok)return;
 const back=await fetch(EMEM+path);if(back.ok&&b32(blake3(new Uint8Array(await back.arrayBuffer())).slice(0,16))===path.match(/([a-z2-7]{26})\.md$/)[1])return;
 throw new Error(`emem refused ${path}: ${x.status} ${(await x.text()).slice(0,200)}`);
};
const store=async body=>{const bytes=U(body),cid=b32(blake3(bytes).slice(0,16)),path=`/memories/by_attester/${pub.slice(0,8)}/${cid}.md`;await put(path,body);return{url:EMEM+path,sha:await sha256(bytes)}};

// load order: dependencies before the modules that import them
const FILES=["emem.eio","src/emem.css","src/vendor/emem-verify-core.js","src/lang.mjs","src/emem.mjs","src/read.mjs","src/point.mjs","src/eio.mjs","llms.txt",".well-known/agent-card.json"];
const lines=[];
for(const f of FILES){const s=await store(read(f));lines.push(`file ${f} ${s.sha} ${s.url}`);console.log("sealed",f)}

// ---------- 3. third-party readers the page may load later, pinned by their bytes ----------
const libs=[...new Set(read("src/read.mjs").match(/NPM\+"[^"]+"/g).map(m=>"https://cdn.jsdelivr.net/npm/"+m.slice(5,-1)))].filter(u=>/\.m?js$/.test(u)&&!/tesseract\.js@[\d.]+\/dist\/worker/.test(u));
for(const u of libs){const x=await fetch(u);if(!x.ok)throw new Error(`${u}: ${x.status}`);lines.push(`lib ${u} ${await sha256(new Uint8Array(await x.arrayBuffer()))}`);console.log("pinned",u)}

const manifest=`# ememdemo site seal

> Every file this site runs, named by its hash, and every library it may load, pinned by its sha256. index.html pins this file; its loader checks each file before running it and restores any that do not match from emem.

sealed_by ${pub}
signer ${P.one("signer")}
source ${b32(blake3(U(src)).slice(0,16))}

${lines.join("\n")}
`;
const m=await store(manifest);
console.log("manifest",m.url);

// ---------- 4. pin it ----------
const html=read("index.html").replace(/const SEAL=\{[^}]*\};/,`const SEAL={url:"${m.url}",sha256:"${m.sha}"};`);
if(!html.includes(m.sha))throw new Error("index.html has no SEAL line to pin");
fs.writeFileSync(ROOT+"index.html",html);
console.log("pinned in index.html");
