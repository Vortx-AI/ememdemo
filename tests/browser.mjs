// tests/browser.mjs: the page in headless Chromium, against live emem.dev. Each case retries once (live network).
//   node tests/browser.mjs            (CHROMIUM=/path/to/chrome to pick the browser; PORT to pick the port)
import {chromium} from "playwright-core";
import {spawn} from "child_process";
import fs from "fs";
import assert from "assert/strict";
const ROOT=new URL("..",import.meta.url).pathname,PORT=+process.env.PORT||8790,BASE=`http://localhost:${PORT}/`;
const MANIFEST=(fs.readFileSync(ROOT+"index.html","utf8").match(/by_attester\/[a-z2-7]{8}\/([a-z2-7]{26})\.md/)||[])[1];
const srv=spawn("python3",["-m","http.server",String(PORT)],{cwd:ROOT,stdio:"ignore"});await new Promise(r=>setTimeout(r,800));
const b=await chromium.launch({executablePath:process.env.CHROMIUM||undefined,args:["--ignore-certificate-errors"]});
let pass=0,fail=0;
const open=async(q="",setup)=>{const ctx=await b.newContext({viewport:{width:1200,height:900}}),pg=await ctx.newPage();const errs=[];pg.on("pageerror",e=>errs.push(e.message));
 if(setup)await setup(pg);await pg.goto(BASE+q);return{pg,ctx,errs}};
const idle=pg=>pg.waitForFunction(()=>document.querySelector("main")?.getAttribute("aria-busy")!=="true",null,{timeout:120000});
const foot=pg=>pg.waitForFunction(()=>document.querySelector(".seal-state,pre"),null,{timeout:60000}).then(()=>pg.waitForTimeout(1500)).then(()=>pg.evaluate(()=>document.querySelector(".seal-state")?.textContent||document.querySelector("pre")?.textContent));
const test=async(name,fn)=>{for(let k=0;k<2;k++){let c;try{await fn(o=>c=o);console.log("ok  ",name);pass++;await c?.ctx.close();return}catch(e){await c?.ctx.close().catch(()=>{});if(k){console.log("FAIL",name,"—",String(e.message).split("\n")[0]);fail++}}}};

await test("sealed page checks every file",async keep=>{const o=await open();keep(o);assert.match(await foot(o.pg),/sealed · (\d+) of \1 files checked/)});
await test("a flipped byte in a site file is restored from emem",async keep=>{const o=await open("",pg=>pg.route(BASE+"src/emem.mjs",async rt=>{const r=await rt.fetch();rt.fulfill({response:r,body:(await r.text()).replace("refused to store it","EVIL")})}));keep(o);
 assert.match(await foot(o.pg),/1 restored from emem/)});
await test("a flipped byte in the manifest stops the page",async keep=>{const o=await open("",pg=>pg.route(`**/${MANIFEST}.md`,async rt=>{const r=await rt.fetch();rt.fulfill({response:r,body:(await r.text())+" "})}));keep(o);
 assert.match(await foot(o.pg),/refused to run[\s\S]*does not match the sha256/)});
await test("the page can boot from emem alone",async keep=>{const o=await open("?boot=emem");keep(o);assert.match(await foot(o.pg),/all run from emem\.dev/)});
for(const[label,fn]of[["a jargon hero",t=>t.replace(/^say .*$/m,"say     Get a signed emem token for any file right now today.")],["a broken flow",t=>t.replace("flow make   : read text split sign store link","flow make   : read split text sign store link")]])
 await test(`the page refuses ${label}`,async keep=>{const o=await open("?boot=local",pg=>pg.route("**/emem.eio",async rt=>{const r=await rt.fetch();rt.fulfill({response:r,body:fn(await r.text())})}));keep(o);
  await o.pg.waitForTimeout(1200);assert.match(await o.pg.textContent("body"),/breaks its own rules/)});
await test("a file whose bytes don't match its name is caught",async keep=>{const o=await open("?boot=local&s="+encodeURIComponent("https://emem.dev/memories/by_attester/ddzmyzhn/avmvdexjuwqwjjzyncczvmfyzq.md"));keep(o);
 await o.pg.waitForSelector(".card");await o.pg.waitForTimeout(500);await idle(o.pg);assert.match(await o.pg.textContent(".out .scope"),/do NOT match their names/)});
await test("a shared link that would read or write runs nothing",async keep=>{const o=await open("?boot=local&s="+encodeURIComponent("world: Paris"));keep(o);
 await o.pg.waitForSelector(".card");assert.match(await o.pg.textContent(".steps"),/runs only when you press/);assert.equal(await o.pg.inputValue("textarea"),"world: Paris")});
await test("nothing is published before Create public link",async keep=>{const o=await open("?boot=local");keep(o);let writes=0;
 o.pg.on("request",r=>{if(r.method()==="POST"&&/memory_create/.test(r.postData()||""))writes++});await o.pg.waitForSelector(".card");
 await o.pg.fill("textarea","publish gate test "+Date.now());await o.pg.click(".go");await o.pg.waitForSelector(".consent:not([hidden])");assert.equal(writes,0);
 await o.pg.click(".consent .halt");await idle(o.pg);assert.equal(writes,0);assert.match(await o.pg.textContent(".steps .err"),/Nothing was published/)});
await test("a big index opens by sampling, and check all reads every section",async keep=>{const o=await open("?boot=local&s="+encodeURIComponent("https://emem.dev/memories/by_attester/ddzmyzhn/aczo4t4lqajwljebeifv2wrpxy.md"));keep(o);
 await o.pg.waitForFunction(()=>document.querySelector(".r1")?.textContent,null,{timeout:60000});assert.match(await o.pg.textContent(".out .scope"),/sections [\d, ]+ of 23 read and match/);
 await o.pg.click(".verbs button");await o.pg.waitForTimeout(400);await idle(o.pg);assert.match(await o.pg.textContent(".out .scope"),/24 of 24 files match/)});

await test("the signing key is non-extractable and never in localStorage",async keep=>{const o=await open("?boot=local");keep(o);await o.pg.waitForSelector(".card");await o.pg.waitForFunction(()=>/key /.test(document.querySelector("footer").textContent));
 const k=await o.pg.evaluate(()=>new Promise(ok=>{const q=indexedDB.open("emem",1);q.onsuccess=()=>{const g=q.result.transaction("keys").objectStore("keys").get("site");g.onsuccess=()=>ok({ext:g.result?.priv?.extractable,ls:localStorage.getItem("emem.key")})}}));
 assert.equal(k.ext,false);assert.equal(k.ls,null)});
await test("a private link opens only with its #k=",async keep=>{const o=await open("?boot=local");keep(o);await o.pg.waitForSelector(".card");
 await o.pg.fill("textarea","private test "+Date.now()+"\nonly with the key");await o.pg.click(".go");await o.pg.waitForSelector(".consent:not([hidden])");await o.pg.check("#enc");await o.pg.click(".consent .publish");await idle(o.pg);
 const link=await o.pg.textContent(".url");assert.match(link,/#k=[A-Za-z0-9_-]{43}$/);const plain=link.replace(/#k=.*/,"");
 assert.match(await (await fetch(plain)).text(),/^---\nemem: sealed\.v1/);
 await o.pg.fill("textarea",plain);await o.pg.click(".go");await idle(o.pg);assert.match(await o.pg.textContent(".steps .err"),/encrypted/);
 await o.pg.fill("textarea",link);await o.pg.click(".go");await idle(o.pg);assert.match(await o.pg.textContent(".out .scope"),/1 of 1 files match/)});
await test("a grant opens only for its share key",async keep=>{const a=await open("?boot=local");keep(a);const bctx=await b.newContext(),B=await bctx.newPage();await B.goto(BASE+"?boot=local");await B.waitForSelector(".card");await a.pg.waitForSelector(".card");
 const share=await B.evaluate(async()=>(await (await import("./src/emem.mjs")).shareKey()).pub);
 await a.pg.fill("textarea","grant test "+Date.now());await a.pg.click(".go");await a.pg.waitForSelector(".consent:not([hidden])");await a.pg.check("#enc");await a.pg.fill(".consent .grant",share);await a.pg.click(".consent .publish");await idle(a.pg);
 const gl=await a.pg.$eval(".verbs a",x=>x.href);assert.match(gl,/#g=[a-z2-7]{8}\/[a-z2-7]{26}$/);
 await B.fill("textarea",gl);await B.click(".go");await idle(B);assert.match(await B.textContent(".out .scope"),/1 of 1 files match/);
 await a.pg.fill("textarea",gl);await a.pg.click(".go");await idle(a.pg);assert.match(await a.pg.textContent(".steps .err"),/another share key/);await bctx.close()});
await test("the page reads a language the source declares",async keep=>{const o=await open("?boot=local&lang=es");keep(o);await o.pg.waitForSelector(".card");assert.match(await o.pg.textContent("h1"),/Tokeniza archivos enormes/)});

await b.close();srv.kill();console.log(`${pass} passed, ${fail} failed`);process.exit(fail?1:0);
