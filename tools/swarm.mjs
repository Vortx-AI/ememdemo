// tools/swarm.mjs: what a crowd costs emem.dev. Opens TABS tabs of the page in one browser (one visitor), leaves them for
// SECONDS, reloads once (a return visit), and counts every request that reaches emem.dev, by kind. Run it with the cache
// on and with ?cache=off to see what the cache saves; multiply by visitors for a crowd.
//   node tools/swarm.mjs [BASE_URL]   (CHROMIUM=/path, TABS=3, SECONDS=150)
import {chromium} from "playwright-core";
import {spawn} from "child_process";
const ROOT=new URL("..",import.meta.url).pathname,PORT=8792,BASE=process.argv[2]||`http://localhost:${PORT}/`,TABS=+process.env.TABS||3,SECS=+process.env.SECONDS||150;
const srv=process.argv[2]?{kill(){}}:spawn("python3",["-m","http.server",String(PORT)],{cwd:ROOT,stdio:"ignore"});await new Promise(r=>setTimeout(r,800));
const b=await chromium.launch({executablePath:process.env.CHROMIUM||undefined,args:["--ignore-certificate-errors"]});
const kind=u=>{const p=new URL(u).pathname;return /\/memories\/by_attester\/[a-z2-7]{8}\/[a-z2-7]{26}\.md$/.test(p)?"note (by hash)":/\/sse|\/stream/.test(p)?"stream":p.startsWith("/v1/log/")?p:p.startsWith("/a2a")?"a2a":p.startsWith("/v1/perception")?"perception":p.startsWith("/v1/inbox")?"inbox":p.startsWith("/memories")?"folder/path":p.split("/").slice(0,3).join("/")};
const run=async q=>{const ctx=await b.newContext(),seen={},count=r=>{const u=r.url();if(!u.startsWith("https://emem.dev/")||r.method()==="OPTIONS")return;const k=kind(u);seen[k]=(seen[k]||0)+1};
 ctx.on("request",count);const pages=[];for(let i=0;i<TABS;i++){const pg=await ctx.newPage();await pg.goto(BASE+q);pages.push(pg)}
 // scroll the catalog open in one tab, as a visitor browsing examples would
 await pages[0].waitForSelector(".card").catch(()=>{});await pages[0].click(".gallery .more").catch(()=>{});
 for(let y=0;y<12;y++){await pages[0].mouse.wheel(0,900);await pages[0].waitForTimeout(400)}
 await pages[0].waitForTimeout(SECS*1000);const first={...seen};for(const k in seen)seen[k]=0;
 await pages[0].reload();await pages[0].waitForSelector(".card").catch(()=>{});await pages[0].click(".gallery .more").catch(()=>{});
 for(let y=0;y<12;y++){await pages[0].mouse.wheel(0,900);await pages[0].waitForTimeout(400)}await pages[0].waitForTimeout(8000);
 await ctx.close();return{first,again:seen}};
const sum=o=>Object.values(o).reduce((a,b)=>a+b,0);
const on=await run("?boot=local"),off=await run("?boot=local&cache=off");
console.log(`one visitor, ${TABS} tabs, ${SECS}s, then one reload — requests reaching emem.dev`);
for(const k of [...new Set([...Object.keys(on.first),...Object.keys(off.first),...Object.keys(on.again),...Object.keys(off.again)])].sort())
 console.log(`${k.padEnd(22)} cache off ${String(off.first[k]||0).padStart(4)} +${String(off.again[k]||0).padStart(3)} on reload   cache on ${String(on.first[k]||0).padStart(4)} +${String(on.again[k]||0).padStart(3)} on reload`);
console.log(`${"total".padEnd(22)} cache off ${String(sum(off.first)).padStart(4)} +${String(sum(off.again)).padStart(3)}             cache on ${String(sum(on.first)).padStart(4)} +${String(sum(on.again)).padStart(3)}`);
await b.close();srv.kill();
