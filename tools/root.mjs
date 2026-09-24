// tools/root.mjs: recompute a pointer's root from nothing but the note, so anyone can check the root line.
//   node tools/root.mjs <pointer note url>
// The recipe (emem.eio, spec pointer.v1), exactly:
//   leaf_i = BLAKE3( utf8(url_i) ‖ u64be(offset_i) ‖ u64be(length_i) ‖ hash_i )   hash_i = the row's 32 raw bytes (from 52-char base32)
//            url_i is the row's url cell; a row marked "·" (the source itself) enters as the EMPTY string, not the source URL
//   node   = BLAKE3( left ‖ right ), both 32 raw bytes; an odd last node is carried up unchanged (not duplicated, not rehashed)
//   rows in table order; root = lowercase base32, no padding, of the final 32 bytes. No domain separation between leaves and nodes.
import "../src/vendor/emem-verify-core.js";
const b3=globalThis.ememVerifyInternals.blake3,U=s=>new TextEncoder().encode(s),A="abcdefghijklmnopqrstuvwxyz234567";
const unb32=s=>{let b=0,v=0;const o=[];for(const c of s){v=(v<<5)|A.indexOf(c);b+=5;if(b>=8){o.push((v>>>(b-8))&255);b-=8}}return new Uint8Array(o)};
const b32=u=>{let b=0,v=0,o="";for(const x of u){v=(v<<8)|x;b+=8;while(b>=5){o+=A[(v>>>(b-5))&31];b-=5}}if(b>0)o+=A[(v<<(5-b))&31];return o};
const u64=n=>{const b=new Uint8Array(8);new DataView(b.buffer).setBigUint64(0,BigInt(n));return b};
const cat=(...a)=>{const r=new Uint8Array(a.reduce((n,x)=>n+x.length,0));let i=0;for(const x of a){r.set(x,i);i+=x.length}return r};
export const rootOf=rows=>{let l=rows.map(c=>b3(cat(U(c.url),u64(c.offset),u64(c.length),unb32(c.hash))));if(!l.length)return"";
 while(l.length>1){const n=[];for(let i=0;i<l.length;i+=2)n.push(i+1<l.length?b3(cat(l[i],l[i+1])):l[i]);l=n}return b32(l[0])};
export const rowsOf=t=>[...t.matchAll(/^\|([^|\n]*)\|([^|\n]*)\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*`?([a-z2-7]{52})`?\s*\|/gm)].map(m=>({url:m[2].trim()==="·"?"":m[2].trim(),offset:+m[3],length:+m[4],hash:m[5]}));
if(process.argv[2]){const t=await (await fetch(process.argv[2])).text(),stated=(t.match(/^root: ([a-z2-7]+)/m)||[])[1],rows=rowsOf(t),got=rootOf(rows);
 console.log(`${rows.length} rows · stated ${stated} · computed ${got} · ${got===stated?"matches":"DOES NOT MATCH"}`);process.exit(got===stated?0:1)}
