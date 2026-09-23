// reel.mjs: the same square of Earth, in true colour, year after year: a timelapse made of signed tokens.
//
// emem mints one emem:cube: per band (red, green, blue) over the square, each member pinned to a Sentinel-2 scene.
// Every frame's pixels are fetched by their artifact name and must hash to it; red, green and blue are joined only where
// the three cubes chose the same scene. The frames are then bound into one emem:rasterset: token.
import {EMEM,net,post,json,receiptOk,b32} from "./emem.mjs";
const blake3=globalThis.ememCrypto.blake3;
export const REEL=/^timelapse:\s*(.+)$/i;
const BANDS=["s2.B04","s2.B03","s2.B02"];

// a place (or "lat, lng") and, optionally, "| 2017-2025 08" for the years and the month
export const parse=input=>{const[q,opt=""]=input.match(REEL)[1].split("|").map(s=>s.trim());
 const y=opt.match(/(\d{4})\s*[-–]\s*(\d{4})/),m=opt.match(/\b(0[1-9]|1[0-2])\b(?!\d)/);
 const a=y?+y[1]:2017,b=y?+y[2]:2025,step=Math.max(1,Math.ceil((b-a+1)/8));
 const years=[];for(let v=a;v<=b;v+=step)years.push(v);return{q,years,month:m?m[1]:"08"}};

// one frame's pixels, by name: the bytes must hash to the artifact cid before they are drawn
const pixels=async cid=>{const x=await net(`${EMEM}/v1/artifacts/${cid}`);if(!x.ok)return null;const buf=new Uint8Array(await x.arrayBuffer());
 if(b32(blake3(buf))!==cid)return{ok:false};const dv=new DataView(buf.buffer),w=dv.getUint32(8,true),h=dv.getUint32(12,true);
 return{ok:true,w,h,px:new Float32Array(buf.buffer.slice(64,64+4*w*h))}};

// red, green and blue cubes over one square; frames where all three share a scene
export const frames=async(p,years,month,S,tick)=>{
 const d=.018,k=Math.cos(p.lat*Math.PI/180),bbox={min_lat:p.lat-d,max_lat:p.lat+d,min_lng:p.lng-d/k,max_lng:p.lng+d/k};
 const dates=years.map(y=>`${y}-${month}-01`);
 tick(`minting red, green and blue across ${dates.length} dates`);
 const cubes=await Promise.all(BANDS.map(band=>post(`${EMEM}/v1/band_cube`,{bbox,band,observed_on:dates}).then(json)));
 return fromCubes(cubes.map(c=>c.tokens.cube),S,tick,{cubes,bbox,dates});
};

// from cube tokens alone (a reopened reel): resolve each, check each signature, fetch and check every frame
export const fromCubes=async(tokens,S,tick,made={})=>{
 const recs=made.cubes||await Promise.all(tokens.map(t=>post(`${EMEM}/v1/cube/resolve`,{token:t}).then(json)));
 const signed=await Promise.all(recs.map(r=>receiptOk(r.receipt,S.signer)));
 const mem=recs.map(r=>(r.derivation||r.record||r).members||[]),scenes=mem[0].filter(m=>mem.every(ms=>ms.some(x=>x.scene_id===m.scene_id))).map(m=>m.scene_id);
 let n=0;const total=scenes.length*3;tick(`0/${total}`);
 const out=[];
 for(const sc of scenes){const trio=mem.map(ms=>ms.find(x=>x.scene_id===sc)),g=await Promise.all(trio.map(async m=>{const q=await pixels(m.artifact_cid);tick(`${++n}/${total}`);return q}));
  out.push({scene:sc,date:trio[0].captured_at.slice(0,10),tokens:trio.map(m=>m.raster_token),grids:g,ok:g.every(x=>x?.ok)})}
 return{tokens,frames:out,signed,bbox:made.bbox,dates:made.dates};
};

// one handle for every frame of every band
export const bind=async(reel,label)=>{const t=reel.frames.flatMap(f=>f.tokens).slice(0,64);if(t.length<2)return null;
 return post(`${EMEM}/v1/raster_bundle`,{tokens:t,purpose:`true-colour timelapse: ${label}`}).then(json).then(j=>(JSON.stringify(j).match(/emem:rasterset:[a-z2-7]+:[a-z2-7]+/)||[])[0]||null).catch(()=>null)};

// frames as pictures: one stretch for all of them (2nd–98th percentile per band), so change reads as change, not as contrast
export const paint=reel=>{
 if(typeof document==="undefined")return[];
 const good=reel.frames.filter(f=>f.ok&&f.grids.every(g=>g.w===f.grids[0].w&&g.h===f.grids[0].h));if(!good.length)return[];
 const lims=[0,1,2].map(b=>{const v=[];for(const f of good){const px=f.grids[b].px;for(let i=0;i<px.length;i+=17)if(Number.isFinite(px[i])&&px[i]>0)v.push(px[i])}v.sort((a,c)=>a-c);return[v[Math.floor(v.length*.02)]||0,v[Math.floor(v.length*.98)]||1]});
 return good.map(f=>{const{w,h}=f.grids[0],cv=document.createElement("canvas");cv.width=w;cv.height=h;cv.className="grid";const g=cv.getContext("2d"),img=g.createImageData(w,h);
  for(let i=0;i<w*h;i++){for(let b=0;b<3;b++){const[lo,hi]=lims[b],v=f.grids[b].px[i];img.data[i*4+b]=Number.isFinite(v)?Math.max(0,Math.min(255,255*Math.pow(Math.max(0,(v-lo)/(hi-lo||1)),.8))):0}img.data[i*4+3]=255}
  g.putImageData(img,0,0);g.font="bold 13px ui-monospace,monospace";g.fillStyle="rgba(0,0,0,.55)";g.fillRect(4,4,86,20);g.fillStyle="#fff";g.fillText(f.date,9,19);cv.dataset.date=f.date;return cv});
};

// the frames, playing: one canvas that shows each frame in turn
export const play=canvases=>{
 if(!canvases.length)return null;const cv=document.createElement("canvas");cv.width=canvases[0].width;cv.height=canvases[0].height;cv.className="preview reel";
 let i=0;const g=cv.getContext("2d"),step=()=>{if(!cv.isConnected&&i>0)return;g.drawImage(canvases[i%canvases.length],0,0);i++;setTimeout(step,i%canvases.length?650:1400)};step();return cv};

export const reelNote=(p,reel,rasterset)=>{
 const ok=reel.frames.filter(f=>f.ok).length;
 return`---\nemem: timelapse.v1\nplace: ${p.label}\ncell: ${p.cell}\nat: ${p.lat?.toFixed(5)}, ${p.lng?.toFixed(5)}\n${reel.bbox?`bbox: ${[reel.bbox.min_lng,reel.bbox.min_lat,reel.bbox.max_lng,reel.bbox.max_lat].map(v=>v.toFixed(5)).join(",")}\n`:""}cubes: ${reel.tokens.join(" ")}\n${rasterset?`rasterset: ${rasterset}\n`:""}frames: ${ok} of ${reel.frames.length} with pixels that hash to their names\nsigned: ${reel.signed.every(Boolean)?"all three cubes, checked against the pinned key":"✗ a cube's signature does not check"}\n---\n\n# ${p.label}, year after year\n\n> The same square, about 4 km across, in true colour. Red, green and blue are each a signed emem:cube:; a frame joins them only where all three chose the same Sentinel-2 scene, and its pixels must hash to their artifact names. One stretch serves every frame, so what changes is the ground, not the contrast.\n\n## Frames\n\n| date | scene | red | green | blue |\n|---|---|---|---|---|\n${reel.frames.map(f=>`| ${f.date} | ${f.scene} | ${f.tokens.join(" | ")} |`).join("\n")}\n`;
};
