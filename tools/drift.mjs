// tools/drift.mjs: re-check watched links and append to each one's drift chain.
//   EMEM_KEY_FILE=key.json node tools/drift.mjs [link ...]     (no links: every pointer in the gallery)
// Each run writes one drift.v1 note per link, addressed to the link's author, and filed under arcade/drift-<cid8>-<time> in the watcher's folder so the chain is one listing:
//   # <me8> -> <author8>: drift <cid8> ok|changed k/n
// It names the previous entry (previous:) and counts entries (entry:), is stamped after the log head, and records
// every chunk it re-read (then/now hash). The page reads the chain back on reopen and checks every entry's author.
import fs from "fs";
import "../src/vendor/emem-verify-core.js";
import {compile} from "../src/lang.mjs";
const {recheck}=await import("../src/point.mjs"),{head,stamp}=await import("../src/time.mjs");
const EMEM="https://emem.dev",ROOT=new URL("..",import.meta.url).pathname,blake3=globalThis.ememCrypto.blake3,U=s=>new TextEncoder().encode(s);
const A="abcdefghijklmnopqrstuvwxyz234567",b32=u=>{let b=0,v=0,o="";for(const x of u){v=(v<<8)|x;b+=8;while(b>=5){o+=A[(v>>>(b-5))&31];b-=5}}if(b>0)o+=A[(v<<(5-b))&31];return o};
const cat=(...a)=>{const r=new Uint8Array(a.reduce((n,x)=>n+x.length,0));let i=0;for(const x of a){r.set(x,i);i+=x.length}return r};
const kj=JSON.parse(fs.readFileSync(process.env.EMEM_KEY_FILE,"utf8"));
const priv=await crypto.subtle.importKey("pkcs8",Buffer.from(kj.priv,"base64"),{name:"Ed25519"},false,["sign"]),pub=b32(new Uint8Array(Buffer.from(kj.pub,"base64"))),me=pub.slice(0,8);
const P=compile(fs.readFileSync(ROOT+"emem.eio","utf8")),signer=P.one("signer");
const put=async(path,body)=>{const d=blake3(cat(U(`emem.memory_write.v2|create|${path}|`),blake3(U(body)),U("|absent"))),sig=b32(new Uint8Array(await crypto.subtle.sign("Ed25519",priv,d)));
 const x=await fetch(`${EMEM}/a2a/tasks`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({skill:"emem_memory_create",args:{path,file_text:body,kind:"resource",attester:{pubkey_b32:pub,sig_b32:sig}}})});
 if(!x.ok)throw new Error(`emem refused ${path}: ${x.status} ${(await x.text()).slice(0,160)}`)};
const links=process.argv.slice(2).length?process.argv.slice(2):P.shows.map(s=>s.emem).filter(u=>/^https:\/\/emem\.dev\/memories\//.test(u));
const out=[];
for(const url of links){try{
 const body=await (await fetch(url)).text();if(!/^emem: pointer\.v1$/m.test(body))continue;
 const cid=url.match(/([a-z2-7]{26})\.md$/)[1],author=url.split("/").at(-2);
 // the chain lives in this key's own folder, one prefix per link: arcade/drift-<cid8>-<time>-to-<author8>.md (time sorts)
 const listed=(await (await fetch(`${EMEM}/memories/by_attester/${me}/arcade/?limit=5000`)).json()).entries||[];
 const prev=listed.filter(e=>e.path.includes(`/arcade/drift-${cid.slice(0,8)}-`)).sort((a,b)=>a.path<b.path?1:-1)[0];
 const prevBody=prev?await (await fetch(EMEM+prev.path)).text():"",entry=(+(prevBody.match(/^entry: (\d+)$/m)||[])[1]||0)+1;
 const c=await recheck(body,()=>{},6),good=c.table&&c.ok===c.n,now=new Date().toISOString(),ts=now.replace(/[-:]/g,"").replace("T","-").slice(0,15);
 let note=`# ${me} -> ${author}: drift ${cid.slice(0,8)} ${good?"ok":"changed"} ${c.ok}/${c.n}\n\n---\nemem: drift.v1\nof: ${url}\nprevious: ${prev?EMEM+prev.path:"none"}\nentry: ${entry}\nsource: ${c.src}\ntable: ${c.table?"matches its root":"does NOT match its root"}\nread: ${c.ok} of ${c.n} chunks match\nat: ${now}\n---\n\n| what | offset | length | then | now |\n|---|---|---|---|---|\n${c.rows.map(r=>`| ${r.label} | ${r.offset} | ${r.length} | ${r.hash} | ${r.now} |`).join("\n")}\n`;
 try{note=stamp(note,await head(signer))}catch{}
 const path=`/memories/by_attester/${me}/arcade/drift-${cid.slice(0,8)}-${ts}-to-${author}.md`;await put(path,note);
 out.push({of:url,entry,ok:good,read:`${c.ok}/${c.n}`,note:EMEM+path});console.log(JSON.stringify(out.at(-1)));
}catch(e){console.log(JSON.stringify({of:url,error:e.message}))}}
console.log(`${out.length} links re-checked, ${out.filter(o=>!o.ok).length} changed`);
