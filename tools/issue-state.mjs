// issue-state.mjs: run every probe in probes.mjs and store each result on emem as a signed, log-stamped note.
//   EMEM_KEY_FILE=key.json node tools/issue-state.mjs [probe-id ...]
// Prints one JSON line per probe: {id, holds, url}. The note is the shared state an issue links to: anyone, including
// emem's own agent, can re-run the probe and compare. When a probe holds, the issue it backs can be closed.
import fs from "fs";
import "../src/vendor/emem-verify-core.js";
import {PROBES} from "./probes.mjs";
const E="https://emem.dev",blake3=globalThis.ememCrypto.blake3,U=s=>new TextEncoder().encode(s);
const A="abcdefghijklmnopqrstuvwxyz234567",b32=u=>{let b=0,v=0,o="";for(const x of u){v=(v<<8)|x;b+=8;while(b>=5){o+=A[(v>>>(b-5))&31];b-=5}}if(b>0)o+=A[(v<<(5-b))&31];return o};
const cat=(...a)=>{const r=new Uint8Array(a.reduce((n,x)=>n+x.length,0));let i=0;for(const x of a){r.set(x,i);i+=x.length}return r};
const kf=process.env.EMEM_KEY_FILE;if(!kf)throw new Error("set EMEM_KEY_FILE");
const kj=JSON.parse(fs.readFileSync(kf,"utf8"));
const priv=await crypto.subtle.importKey("pkcs8",Buffer.from(kj.priv,"base64"),{name:"Ed25519"},false,["sign"]),pub=b32(new Uint8Array(Buffer.from(kj.pub,"base64")));
const put=async body=>{
 const bytes=U(body),cid=b32(blake3(bytes).slice(0,16)),path=`/memories/by_attester/${pub.slice(0,8)}/${cid}.md`;
 const sig=b32(new Uint8Array(await crypto.subtle.sign("Ed25519",priv,blake3(cat(U(`emem.memory_write.v2|create|${path}|`),blake3(bytes),U("|absent"))))));
 const x=await fetch(`${E}/a2a/tasks`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({skill:"emem_memory_create",args:{path,file_text:body,kind:"resource",attester:{pubkey_b32:pub,sig_b32:sig}}})});
 if(!x.ok&&!(await fetch(E+path)).ok)throw new Error(`emem refused ${path}: ${x.status}`);return E+path;
};
const sth=(await (await fetch(`${E}/v1/log/sth`)).json()).sth;
const want=process.argv.slice(2);
for(const p of PROBES.filter(p=>!want.length||want.includes(p.id))){
 let res;try{res=await p.run()}catch(e){res={holds:false,observed:{error:String(e.message||e)}}}
 const at=new Date().toISOString();
 const body=`---\nemem: issue-state.v1\nafter: sth ${sth.tree_size} ${sth.root_b32} ${sth.signed_at}\nissue: ${p.id}\nholds: ${res.holds}\nat: ${at}\nrepo: https://github.com/Vortx-AI/ememdemo\nrecheck: EMEM_KEY_FILE=<key> node tools/issue-state.mjs ${p.id}\n---\n\n# ${p.id}: ${p.title}\n\n> ${p.ask}\n\n## Observed\n\n\`\`\`json\n${JSON.stringify(res.observed,null,1)}\n\`\`\`\n\n${res.holds?"The probe holds: emem.dev already does this.":"The probe does not hold yet."} Run it again with the command above; the answer is recomputed, not remembered.\n`;
 const url=await put(body);
 console.log(JSON.stringify({id:p.id,holds:res.holds,url,observed:res.observed}));
}
