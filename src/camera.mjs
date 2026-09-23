// camera.mjs: street cameras, as geo.qa encodes them and emem.dev fronts them, re-checked in this browser.
//
// geo.qa keeps a clip from each camera and names it by its sha256. Its postcard (geoqa.postcard.v2, inside each card's
// SVG) says which clip, which camera, where and when, what a named detector counted in it, and where the sun was.
// Here each clip is downloaded and hashed again, and the sun's position is recomputed from latitude, longitude and time.
// The counts are not signed by anyone: they are a detector's reading, reproducible from the clip under its fn id.
import {EMEM,net,json,b32} from "./emem.mjs";
const blake3=globalThis.ememCrypto.blake3;
const P=`${EMEM}/v1/perception`;
export const CAMERA=/^cameras?:\s*(.*)$/i;
const unesc=t=>t.replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");
const sha256=async b=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",b))].map(x=>x.toString(16).padStart(2,"0")).join("");

// where the sun is, from latitude, longitude and UTC alone (low-precision almanac, ~0.01° for 1950–2050)
export const sun=(lat,lon,utc)=>{
 const r=Math.PI/180,d=(Date.parse(utc)/864e5+2440587.5)-2451545,g=(357.529+.98560028*d)*r,q=280.459+.98564736*d;
 const L=(q+1.915*Math.sin(g)+.02*Math.sin(2*g))*r,e=(23.439-3.6e-7*d)*r;
 const ra=Math.atan2(Math.cos(e)*Math.sin(L),Math.cos(L)),dec=Math.asin(Math.sin(e)*Math.sin(L));
 const gmst=(18.697374558+24.06570982441908*d)%24,ha=((gmst*15+lon)*r-ra),la=lat*r;
 const el=Math.asin(Math.sin(la)*Math.sin(dec)+Math.cos(la)*Math.cos(dec)*Math.cos(ha));
 const az=Math.atan2(-Math.sin(ha),Math.tan(dec)*Math.cos(la)-Math.sin(la)*Math.cos(ha));
 return{elevation:el/r,azimuth:((az/r)%360+360)%360};
};

// the postcard inside a card's SVG: its <metadata> holds the record the picture was painted from
const postcard=async slug=>{
 const x=await net(`${P}/cards/${slug}/latest.svg`);if(!x.ok)return null;
 const t=await x.text(),m=t.match(/<observation[^>]*>([\s\S]*?)<\/observation>/)||t.match(/<metadata[^>]*>\s*([{][\s\S]*?)<\/metadata>/);if(!m)return null;
 try{return JSON.parse(unesc(m[1]).trim())}catch{return null}
};

// the cameras: which places, their clips re-hashed, their skies recomputed
export const look=async(q,tick)=>{
 tick("asking which cameras are live");
 const c=await json(await net(`${P}/cards`)),want=q.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
 let places=(c.places||[]).filter(p=>!want||want==="london"||want==="all"||p.slug.includes(want)||want.includes(p.slug));
 if(!places.length)throw new Error(`No camera matches "${q}". Live places: ${(c.places||[]).map(p=>p.slug.replace(/-/g," ")).join(", ")}.`);
 let done=0;tick(`0/${places.length}`);
 const rows=await Promise.all(places.map(async p=>{
  const pc=await postcard(p.slug).catch(()=>null),clipUrl=pc?.verify_urls?.clip?P+pc.verify_urls.clip:null;
  let got=null,b3=null,size=0;
  if(clipUrl){const x=await net(clipUrl).catch(()=>null);if(x?.ok){const b=new Uint8Array(await x.arrayBuffer());size=b.length;got=await sha256(b);b3=b32(blake3(b))}}
  const sky=pc?.sky,s=sky?.computed_from?sun(sky.computed_from.lat,sky.computed_from.lon,sky.computed_from.utc):null;
  tick(`${++done}/${places.length}`);
  return{slug:p.slug,cell:p.cell64,camera:p.camera_id,distance:p.camera_distance_m,counts:p.counts||null,scene:p.frame_scene,showable:p.showable,
   captured:pc?.captured_at||p.newest,detector:pc?.detector?.fn_id||p.detector_fn_id,clip:clipUrl,want:p.clip_sha256,got,b3,size,clipCid:pc?.clip_cid,
   sky:sky&&s?{stated:[sky.sun_elevation_deg,sky.sun_azimuth_deg],now:[s.elevation,s.azimuth]}:null,thumb:`${P}/cards/${p.slug}/thumb.png`};
 }));
 // geo.qa's own signature over each clip (geoqa.clip.v1): fetched when its verify route answers, and said plainly when it does not
 const key=await net(`${P}/verify/key`).then(x=>x.ok?x.json():null).catch(()=>null);
 const probe=rows.find(r=>r.clipCid),rc=probe?await net(`${P}/verify/clip/${probe.clipCid}`).then(x=>x.status).catch(()=>0):0;
 return{rows,key:key?.pubkey_b64||null,receipts:rc===200?"answering":`not answering (status ${rc||"unreachable"})`,state:c.state_id};
};

// the survey, as a note: one row per camera, each clip named by the hash this page computed
export const keep=v=>{
 const f=n=>n==null?"—":(+n).toFixed(2),rows=v.rows,okClip=rows.filter(r=>r.got&&r.got===r.want).length,skies=rows.filter(r=>r.sky),okSky=skies.filter(r=>Math.abs(r.sky.stated[0]-r.sky.now[0])<.1&&Math.abs(((r.sky.stated[1]-r.sky.now[1]+540)%360)-180)<.1).length;
 const newest=rows.map(r=>r.captured).filter(Boolean).sort().pop()||"";
 const counts=r=>r.counts?Object.entries(r.counts).map(([k,n])=>`${n} ${k}`).join(", "):r.scene&&r.scene!=="scene"?`not counted: ${String(r.scene).replace(/_/g," ")}`:"not counted";
 const body=`---\nemem: camera.v1\nsource: ${P}/cards\ncameras: ${rows.length}\nclips: ${okClip} of ${rows.length} re-hashed here and match their sha256\nsun: ${okSky} of ${skies.length} positions recomputed here within 0.1°\nsigner: geo.qa ${v.key?`ed25519 ${v.key}`:"key not reachable"}; clip receipts ${v.receipts}\nstate: ${v.state||"—"}\n---\n\n# Street cameras, London, as of ${newest.slice(0,16).replace("T"," ")} UTC\n\n> ${rows.length} traffic cameras read through emem.dev from geo.qa. Each clip is named by its sha256; this page downloaded every clip and hashed it again (and with BLAKE3, emem's hash). Counts are a detector's reading under the named fn id: reproducible from the clip, not signed. The sun's position is recomputed from latitude, longitude and time, and must agree.\n\n- ${okClip} of ${rows.length} clips re-hashed and matching\n- ${okSky} of ${skies.length} sun positions recomputed within 0.1°\n- geo.qa signs the clip (camera, time, place, bytes), never the counts; emem signs the facts about the place\n\n## Cameras\n\n| place | cell | camera | captured (UTC) | counted | sun, stated → recomputed | clip | sha256 | blake3 |\n|---|---|---|---|---|---|---|---|---|\n${rows.map(r=>`| ${r.slug.replace(/-/g," ")} | ${r.cell} | ${r.camera} | ${(r.captured||"").slice(0,19).replace("T"," ")} | ${counts(r)} | ${r.sky?`${f(r.sky.stated[0])}°/${f(r.sky.stated[1])}° → ${f(r.sky.now[0])}°/${f(r.sky.now[1])}°`:"—"} | ${r.clip||"—"} | ${r.got?(r.got===r.want?r.got:`MISMATCH: ${r.got} (stated ${r.want})`):`not fetched (stated ${r.want})`} | ${r.b3||"—"} |`).join("\n")}\n\nEach place reads further as \`world: <place>, London\`.\n`;
 return{body,okClip,okSky,skies:skies.length,n:rows.length};
};

// reopened: every clip fetched and hashed again; a clip replaced at the source no longer matches the name kept here
export const rehash=async(body,tick)=>{
 const found=[...body.matchAll(/^\| ([^|]+) \| [^|]+ \| [^|]+ \| [^|]+ \| ([^|]+) \| [^|]+ \| (https:\S+\.mp4) \| ([0-9a-f]{64}) \|/gm)],rows=found.map(m=>({place:m[1],url:m[3],want:m[4]})),counts=found.map(m=>m[2]);
 let ok=0,n=0;
 await Promise.all(rows.map(async r=>{const x=await net(r.url).catch(()=>null);const got=x?.ok?await sha256(await x.arrayBuffer()):null;if(got===r.want)ok++;tick(`${++n}/${rows.length}`)}));
 return{ok,n:rows.length,thumbs:rows.filter((r,i)=>/\d/.test(counts[i]||"")).map(r=>`${P}/cards/${r.place.trim().replace(/ /g,"-")}/thumb.png`)};
};
