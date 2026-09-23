// thumbs.mjs: a gallery card's picture, made by opening its link in a real browser and keeping what the page drew.
//   EMEM_KEY_FILE=key.json node tools/thumbs.mjs <link> [<link> ...]      (needs playwright-core and Chromium)
// The page draws only from bytes it has just checked (pointer chunks, raster artifacts, frames). The picture is stored
// as its own note (emem: thumb.v1) that names the link it shows; a card shows it only if both names check.
import {chromium} from "playwright-core";
import {spawn} from "child_process";
import fs from "fs";
const ROOT=new URL("..",import.meta.url).pathname,key=fs.readFileSync(process.env.EMEM_KEY_FILE,"utf8"),PORT=8799;
const srv=spawn("python3",["-m","http.server",String(PORT)],{cwd:ROOT,stdio:"ignore"});await new Promise(r=>setTimeout(r,800));
const b=await chromium.launch({executablePath:process.env.CHROMIUM||"/opt/pw-browsers/chromium",args:["--ignore-certificate-errors"]});
const ctx=await b.newContext({viewport:{width:1100,height:1000}});await ctx.addInitScript(k=>{try{localStorage.setItem("emem.key",k)}catch{}},key);
const pg=await ctx.newPage();
for(const link of process.argv.slice(2)){
 await pg.goto(`http://localhost:${PORT}/?boot=local&s=${encodeURIComponent(link)}`);await pg.waitForSelector(".card");await pg.waitForTimeout(500);
 await pg.waitForFunction(()=>document.querySelector("main").getAttribute("aria-busy")!=="true",null,{timeout:300000});
 const url=await pg.evaluate(async link=>{
  // a timelapse keeps every frame; anything else, its first picture
  let all=[...document.querySelectorAll(".out .thumbs canvas")].filter(c=>!c.classList.contains("reel"));
  // camera stills (served with CORS) become frames too
  if(!all.length){await Promise.all([...document.querySelectorAll(".out .thumbs img.cam")].map(i=>i.decode().catch(()=>null)));
   const imgs=[...document.querySelectorAll(".out .thumbs img.cam")].filter(i=>i.complete&&i.naturalWidth).slice(0,6);
   all=imgs.map((im,k)=>{const c=document.createElement("canvas");c.width=im.naturalWidth;c.height=im.naturalHeight;c.getContext("2d").drawImage(im,0,0);c.dataset.date=String(k);return c})}
  const frames=all.length>1&&all.every(c=>c.dataset.date)?all:all.slice(0,1);if(!frames.length)return null;
  const W=320,H=200,s=document.createElement("canvas");s.width=W*frames.length;s.height=H;const g=s.getContext("2d");g.fillStyle="#111";g.fillRect(0,0,s.width,s.height);
  frames.forEach((c,i)=>{const k=Math.max(W/c.width,H/c.height),w=c.width*k,h=c.height*k;g.save();g.beginPath();g.rect(i*W,0,W,H);g.clip();g.drawImage(c,i*W+(W-w)/2,(H-h)/2,w,h);g.restore()});
  const data=s.toDataURL("image/webp",.82);
  const body=`---\nemem: thumb.v1\nof: ${link}\nframes: ${frames.length}\ndrawn: by the page, only from bytes it had just checked against their names\n---\n\n${data}\n`;
  const m=await import("./src/emem.mjs"),k=await m.key(),n=await m.note(body,k);await m.put(n,k.pub);return n.url},link);
 console.log(JSON.stringify({link,thumb:url}));
}
await b.close();srv.kill();
