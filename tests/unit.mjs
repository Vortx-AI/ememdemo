// tests/unit.mjs: offline checks of the pure parts (the eio compiler, r1 lines, the handoff grammar). No network.
import fs from "fs";
import {execFileSync} from "child_process";
import assert from "assert/strict";
import {compile} from "../src/lang.mjs";
import {line,tokenLine,refOf} from "../src/line.mjs";
const ROOT=new URL("..",import.meta.url).pathname;let n=0;const t=(name,fn)=>{fn();n++;console.log("ok",name)};

const P=compile(fs.readFileSync(ROOT+"emem.eio","utf8"));
t("emem.eio compiles, every flow names known steps",()=>{for(const[f,steps]of Object.entries(P.flows))for(const s of steps)assert.ok(P.steps[s],`flow ${f}: unknown step ${s}`)});
t("every step carries its verbs",()=>{for(const[s,v]of Object.entries(P.steps))assert.ok(v.doing&&v.done,s)});
t("every gallery card says who keeps it",()=>{for(const s of P.shows)assert.ok(s.by||s.emem==="live",s.title)});
t("specs exist for every note kind the site writes",()=>{const specs=new Set(P.all("spec").map(s=>s.arg.trim()));for(const k of["r1","pointer.v1","grid.v1","request.v1","claim.v1","deliver.v1","verify.v1"])assert.ok(specs.has(k),k)});

const ptr=`---\nemem: pointer.v1\nspec: mlxrdcys43hao7cz554s46bp7a\nkind: GeoTIFF (COG)\nsource: https://esawebb.org/media/archives/images/original/weic2205a.tif\nbytes: 143700000\nchunks: 97 of 1690 hashed\nroot: etmgt35lbnxyz\n---\n`;
const url="https://emem.dev/memories/by_attester/ddzmyzhn/wkxa7tcmw2orf7ujjf5yi66dhe.md";
t("r1 line for a pointer",()=>assert.equal(line(ptr,url),"r1 pointed cog ddzmyzhn/wkxa7tcmw2orf7ujjf5yi66dhe src=esawebb.org/media/archiv…original/weic2205a.tif size=143.7MB hashed=97/1690 root=etmgt35lbn spec=mlxrdcys43"));
t("brief line drops hashes and keeps the host",()=>assert.equal(line(ptr,url,true),"r1 pointed cog ddzmyzhn/wkxa7tcmw2orf7ujjf5yi66dhe src=esawebb.org size=143.7MB hashed=97/1690"));
t("a line is far smaller than its note",()=>assert.ok(line(ptr,url).length<ptr.length));
t("refs and tokens",()=>{assert.equal(refOf(url),"ddzmyzhn/wkxa7tcmw2orf7ujjf5yi66dhe");assert.match(tokenLine("emem:fact:abc:def"),/^r1 resolve fact /)});
const req=`---\nemem: request.v1\nfrom: ${"a".repeat(52)}\nto: ${"b".repeat(52)}\nwant: witness\nof: ${url}\nexpires: sth 900\nline: request - wkxa7tcm -\n---\n\n# aaaaaaaa -> bbbbbbbb: request witness wkxa7tcm\n`;
t("r1 line for a request",()=>assert.match(line(req,"https://emem.dev/memories/by_attester/aaaaaaaa/arcade/request-x-to-bbbbbbbb.md"),/^r1 requested witness aaaaaaaa\/arcade\/request-x-to-bbbbbbbb of=ddzmyzhn\/wkxa7tcmw2orf7ujjf5yi66dhe to=bbbbbbbb from=aaaaaaaa$/));
t("no regex lookbehind in page code (older Safari can't parse it, so the whole page would fail to load)",()=>{for(const f of fs.readdirSync(ROOT+"src").filter(f=>f.endsWith(".mjs")))assert.ok(!/\(\?<[=!]/.test(fs.readFileSync(ROOT+"src/"+f,"utf8")),f)});
t("the manifest has a copy next to the page, so the site boots when emem.dev is unreachable",()=>{const html=fs.readFileSync(ROOT+"index.html","utf8");assert.match(html,/\.\/seal\.md/);assert.ok(fs.existsSync(ROOT+"seal.md"))});
const{expired}=await import("../src/hand.mjs").catch(()=>({}));
if(expired)t("expiry is a log head: void once the log is longer, still read for old wall-clock requests",()=>{assert.ok(!expired("sth 900",900));assert.ok(expired("sth 900",901));assert.ok(expired("2000-01-01T00:00:00Z",0))});
t("every page module parses (a syntax error anywhere stops the whole sealed page)",()=>{for(const f of fs.readdirSync(ROOT+"src").filter(f=>f.endsWith(".mjs")))execFileSync(process.execPath,["--check",ROOT+"src/"+f],{stdio:"pipe"})});
// verbs before prose: every r1 line leads with what was done (a past-tense verb), and the result view is headed by it
t("every r1 line kind leads with a past-tense verb",()=>{const src=fs.readFileSync(ROOT+"src/line.mjs","utf8"),vs=[...new Set([...src.matchAll(/L\("([a-z_]+)"/g)].map(m=>m[1]))];
 assert.ok(vs.length>10);for(const v of vs)assert.match(v,/(ed|drew|read|kept|woven|sent|made)$/,v)});
t("result proofs are written verb-first, not as sentences",()=>{const src=fs.readFileSync(ROOT+"src/eio.mjs","utf8");
 for(const bad of["files stored`","receipts checked ·","chunks hashed at","one name commits to","It is a","the index matches its name"])assert.ok(!src.includes(bad)||/shape[:=]/.test(src.slice(src.indexOf(bad)-40,src.indexOf(bad))),bad)});
// the cache: emem is the cache, so a crowd costs emem.dev one request per name (forever) or per interval (live)
await import("../src/vendor/emem-verify-core.js");globalThis.ememCrypto??={blake3:globalThis.ememVerifyInternals.blake3};
const C=await import("../src/cache.mjs");C.setPolicy(P.all("cache").map(c=>c.arg));
const A32="abcdefghijklmnopqrstuvwxyz234567",b32=u=>{let b=0,v=0,o="";for(const x of u){v=(v<<8)|x;b+=8;while(b>=5){o+=A32[(v>>>(b-5))&31];b-=5}}if(b>0)o+=A32[(v<<(5-b))&31];return o};
const body=new TextEncoder().encode("# a note\n"),cid=b32(globalThis.ememCrypto.blake3(body).slice(0,16)),nu=`https://emem.dev/memories/by_attester/aaaaaaaa/${cid}.md`;
let calls=0;const ok=(b=body,st=200,h={})=>async()=>{calls++;return new Response(b,{status:st,headers:h})};
const at=async(fn)=>{calls=0;await fn();return calls};
const tA=async(name,fn)=>{await fn();n++;console.log("ok",name)};
await tA("a note named by its hash is read from the network once, then kept",async()=>{assert.equal(await at(async()=>{for(let i=0;i<5;i++){const x=await C.cached(nu,{},ok());assert.equal(await x.text(),"# a note\n")}}),1)});
await tA("bytes that don't hash to the name are never kept",async()=>{const bad=nu.replace(cid,"b".repeat(26));assert.equal(await at(async()=>{for(let i=0;i<3;i++)await C.cached(bad,{},ok())}),3)});
await tA("a thousand identical reads in flight become one request",async()=>{const u="https://emem.dev/v1/inbox?to=zzzzzzzz&limit=5";
 assert.equal(await at(()=>Promise.all(Array.from({length:1000},()=>C.cached(u,{},async()=>{calls++;await new Promise(z=>setTimeout(z,20));return new Response("{}",{status:200})})))),1)});
await tA("emem down: the last good copy of a moving read answers, marked stale",async()=>{C.setPolicy(["live 0 GET ^https://t\\.example/head$"]);const u="https://t.example/head";
 await C.cached(u,{},ok("{\"a\":1}"));const x=await C.cached(u,{},async()=>{throw new Error("down")});assert.equal(x.headers.get("x-emem-cache"),"stale");assert.equal(await x.text(),"{\"a\":1}");C.setPolicy(P.all("cache").map(c=>c.arg))});
await tA("a 429 cools the host: stale copies answer, no request is made",async()=>{C.setPolicy(["live 0 GET ^https://u\\.example/"]);const u="https://u.example/w";await C.cached(u,{},ok("{}"));
 await C.cached(u,{},ok("x",429,{"retry-after":"60"}));assert.equal(await at(()=>C.cached(u,{},ok())),0);C.setPolicy(P.all("cache").map(c=>c.arg))});
await tA("a write primes the cache: the writer never reads its own note back",async()=>{const b=new TextEncoder().encode("# mine\n"),c=b32(globalThis.ememCrypto.blake3(b).slice(0,16)),u=`https://emem.dev/memories/by_attester/aaaaaaaa/${c}.md`;
 C.prime(u,b);assert.equal(await at(()=>C.cached(u,{},ok())),0)});
await tA("writes and unlisted reads pass straight through",async()=>{assert.equal(await at(()=>C.cached("https://emem.dev/a2a/tasks",{method:"POST",body:JSON.stringify({skill:"emem_memory_create"})},ok())),1)});
console.log(`${n} passed`);
