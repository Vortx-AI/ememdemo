// time.mjs: when something was written, proven rather than claimed.
//
// emem.dev keeps an append-only transparency log of everything it signs; its head (tree size and root) is signed.
// A note that carries the head it was written against cannot have been written before that head existed: nobody knows
// a future root. Later, a consistency proof shows the log still contains that head as a prefix, so the history it
// was stamped against has not been rewritten. The writer's key also co-signs the head, which makes every visitor a
// witness of the log.
import {EMEM,U,b32,net,json,post} from "./emem.mjs";
const blake3=globalThis.ememCrypto.blake3;

const I=()=>globalThis.ememVerifyInternals;
const preV1=(domain,segs)=>{const o=[...U("emem.preimage.v1\0")],d=U(domain),u32=n=>o.push(n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255);u32(d.length);o.push(...d);for(const[t,b]of segs){o.push(t);u32(b.length);o.push(...b)}return new Uint8Array(o)};
const be=(n,w)=>{const o=[];let v=BigInt(n);for(let i=0;i<w;i++){o.unshift(Number(v&255n));v>>=8n}return o};
const cat=(...a)=>{const r=new Uint8Array(a.reduce((n,x)=>n+x.length,0));let i=0;for(const x of a){r.set(x,i);i+=x.length}return r};

// the current head, its signature checked against the pinned responder key; cached for a minute so a burst of writes shares it
let cached=null;
export const head=async signer=>{
 if(cached&&Date.now()-cached.at<60e3)return cached.sth;
 const s=(await json(await net(`${EMEM}/v1/log/sth`))).sth,{ed,b32decode}=I();
 const ok=ed.verify(b32decode(s.signature_b32),blake3(preV1("emem.translog.sth.v1",[[1,be(s.tree_size,8)],[2,[...b32decode(s.root_b32)]],[3,[...U(s.signed_at)]],[4,[...b32decode(s.responder_pubkey_b32)]]])),b32decode(s.responder_pubkey_b32))&&s.responder_pubkey_b32===signer;
 if(!ok)throw new Error("emem.dev's log head does not verify against the pinned key; nothing is stamped with it.");
 cached={at:Date.now(),sth:s};return s;
};

// "after: sth <size> <root> <signed_at>": the lower bound on when a body was written, added to its front matter
export const stamp=(body,s)=>{
 const line=`after: sth ${s.tree_size} ${s.root_b32} ${s.signed_at}`;
 if(body.startsWith("---\n"))return body.replace(/^---\n/,`---\n${line}\n`);
 // a note whose first line must stay its title (an addressed note) keeps it; the stamp joins its own front matter
 if(/\n---\nemem: /.test(body))return body.replace(/\n---\nemem: /,`\n---\n${line}\nemem: `);
 return`---\n${line}\n---\n\n${body}`;
};
export const stampOf=body=>{const m=body.match(/^after: sth (\d+) ([a-z2-7]+) (\S+)$/m);return m?{size:+m[1],root:m[2],at:m[3]}:null};

// RFC 9162 §2.1.4.2 consistency check, with emem's hashing (node = blake3(0x01 ‖ left ‖ right))
const node=(l,r)=>blake3(cat(new Uint8Array([1]),l,r));
const eq=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
export const consistent=(first,second,firstRoot,secondRoot,proof)=>{
 if(first===second)return!proof.length&&eq(firstRoot,secondRoot);
 if(first<1||first>second||!proof.length)return false;
 const p=(first&(first-1))===0?[firstRoot,...proof]:[...proof];
 let fn=BigInt(first-1),sn=BigInt(second-1);while(fn&1n){fn>>=1n;sn>>=1n}
 let fr=p[0],sr=p[0];
 for(const c of p.slice(1)){
  if(sn===0n)return false;
  if((fn&1n)||fn===sn){fr=node(c,fr);sr=node(c,sr);if(!(fn&1n))while(!(fn&1n)&&fn!==0n){fn>>=1n;sn>>=1n}}
  else sr=node(sr,c);
  fn>>=1n;sn>>=1n;
 }
 return sn===0n&&eq(fr,firstRoot)&&eq(sr,secondRoot);
};

// has the history a note was stamped against survived? the old head must be a prefix of today's log
export const since=async(st,signer)=>{
 const now=await head(signer),{b32decode}=I();
 if(now.tree_size<st.size)return{ok:false,why:`the log is now shorter (${now.tree_size}) than the head this was stamped against (${st.size})`};
 if(now.tree_size===st.size)return{ok:now.root_b32===st.root,now,grown:0};
 const c=await json(await net(`${EMEM}/v1/log/consistency?first=${st.size}&second=${now.tree_size}`));
 const ok=c.first_root_b32===st.root&&c.second_root_b32===now.root_b32&&consistent(st.size,now.tree_size,b32decode(st.root),b32decode(now.root_b32),c.consistency_proof_b32.map(x=>b32decode(x)));
 return{ok,now,grown:now.tree_size-st.size};
};

// the writer co-signs the head it stamped against: one more independent witness of the log (PreimageV1 "emem.translog.witness.v1")
export const cosign=async(s,k)=>{
 const{b32decode}=I(),d=blake3(preV1("emem.translog.witness.v1",[[1,be(s.tree_size,8)],[2,[...b32decode(s.root_b32)]],[3,[...b32decode(k.pub)]]]));
 const sig=b32(new Uint8Array(await crypto.subtle.sign("Ed25519",k.priv,d)));
 const x=await post(`${EMEM}/v1/log/witness`,{tree_size:s.tree_size,root_b32:s.root_b32,witness_pubkey_b32:k.pub,signature_b32:sig}).catch(()=>null);
 return!!x?.ok;
};
