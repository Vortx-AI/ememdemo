// tests/unit.mjs: offline checks of the pure parts (the eio compiler, r1 lines, the handoff grammar). No network.
import fs from "fs";
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
console.log(`${n} passed`);
