// grid.mjs: a place as a grid of signed facts, drawn as maps; the maps are the evidence, square by square.
//
//  city:   vegetation, ground heat and buildings over a ~6 km square, plus building footprints at the centre;
//          the page measures how heat follows green (Pearson r over every square that has both).
//  forest: canopy in 2000, year of loss and vegetation now over a ~4 km square, read against the EU deforestation
//          rule (Regulation 2023/1115): forest = canopy ≥ 10 %, cut-off 31 December 2020.
// Every square is a cell about 10 m across whose facts carry emem's signature; each value is bound into a bundle.
import {EMEM,net,post,json,receiptOk,fmt,pool} from "./emem.mjs";
export const GRID=/^(city|forest):\s*(.{2,120})$/i;
export const PRESETS={
 city:{span:.027,n:12,maps:[["indices.ndvi","green","vegetation"],["modis.lst_day_8day","heat","ground heat, day"],["overture.buildings.count","ink","buildings"]]},
 forest:{span:.018,n:12,maps:[["hansen.tree_cover_2000","green","canopy, 2000"],["hansen.loss_year","loss","year of forest loss"],["indices.ndvi","green","vegetation now"]]}};

export const sample=async(kind,p,S,tick)=>{
 const P=PRESETS[kind],n=P.n,k=Math.cos(p.lat*Math.PI/180),bands=P.maps.map(m=>m[0]),pts=[];
 for(let i=0;i<n;i++)for(let j=0;j<n;j++)pts.push([p.lat+P.span-2*P.span*i/(n-1),p.lng+(-P.span+2*P.span*j/(n-1))/k]);
 const cells=new Array(pts.length);let done=0;tick(`0/${pts.length}`);
 await pool(pts.map((q,i)=>[q,i]),16,async([q,i])=>{const l=await net(`${EMEM}/v1/locate?lat=${q[0].toFixed(6)}&lng=${q[1].toFixed(6)}`).then(json).catch(()=>null);cells[i]=l?.cell64||null;tick(`${++done}/${pts.length}`)});
 // two passes: the first materialises what it can within its budget, the second collects what was still pending
 const by={},todo=()=>cells.filter(c=>c&&!(by[c]?.facts||[]).length);
 for(const budget of[15000,12000]){const want=todo();if(!want.length)break;tick(`recalling ${want.length} squares`);
  const r=await post(`${EMEM}/v1/recall_many`,{cells:want,bands,budget_ms:budget}).then(json).catch(()=>({}));Object.assign(by,r.by_cell||{})}
 tick("checking every square's receipt");
 const signed=await Promise.all(cells.map(c=>c&&by[c]?.receipt?receiptOk(by[c].receipt,S.signer):null));
 const vals={},toks={};for(const b of bands){vals[b]=cells.map(c=>{const f=(by[c]?.facts||[]).filter(x=>x.band===b&&x.value!=null).pop();return f?Number(f.value):null});toks[b]=cells.map(c=>(by[c]?.facts||[]).filter(x=>x.band===b).pop()?.memory_token||null)}
 // one handle per map: every square's fact for that band, bound into one signed bundle
 tick("one handle per map");
 const bundles=await Promise.all(bands.map(b=>{const tr=cells.map((c,i)=>vals[b][i]!=null?{cell:c,band:b}:null).filter(Boolean).slice(0,256);
  return tr.length?post(`${EMEM}/v1/memory_bundle`,{triples:tr,purpose:`${kind} grid: ${b} at ${p.label}`}).then(json).then(j=>j.bundle_token||null).catch(()=>null):null}));
 const extra={};
 if(kind==="city"){const d=.0035;extra.buildings=await post(`${EMEM}/v1/building_footprints`,{polygon_bbox:{min_lat:p.lat-d,max_lat:p.lat+d,min_lng:p.lng-d/k,max_lng:p.lng+d/k},max_features:4000}).then(json).catch(()=>null);extra.box=d}
 if(kind==="forest")extra.alert=await post(`${EMEM}/v1/deforestation_alert`,{cell:p.cell}).then(json).catch(()=>null);
 return{kind,p,n,cells,vals,toks,bundles,signed,extra,bands};
};

// what the grid says, computed here from the signed values
const pearson=(a,b)=>{const x=[],y=[];a.forEach((v,i)=>{if(v!=null&&b[i]!=null){x.push(v);y.push(b[i])}});if(x.length<8)return null;
 const m=v=>v.reduce((s,q)=>s+q,0)/v.length,mx=m(x),my=m(y);let sxy=0,sx=0,sy=0;x.forEach((v,i)=>{sxy+=(v-mx)*(y[i]-my);sx+=(v-mx)**2;sy+=(y[i]-my)**2});return{r:sxy/Math.sqrt(sx*sy),n:x.length}};
const lossYear=v=>v==null||v<=0?null:v<100?2000+v:v;
export const findings=g=>{const f=[];
 if(g.kind==="city"){const t=g.vals["modis.lst_day_8day"].map(v=>v==null?null:v>200?v-273.15:v),r=pearson(g.vals["indices.ndvi"],t);
  if(r)f.push(`greener squares are ${r.r<0?"cooler":"warmer"}: Pearson r = ${r.r.toFixed(2)} between vegetation and ground heat over ${r.n} squares`);
  const hot=t.filter(v=>v!=null);if(hot.length)f.push(`ground heat by day spans ${Math.min(...hot).toFixed(1)}–${Math.max(...hot).toFixed(1)} °C across the grid`);
  const B=g.extra.buildings;if(B)f.push(`${B.count} building footprints in the central ${Math.round(g.extra.box*2*111)} km square (Overture ${B.release||""})${B.truncated?", truncated":""}`)}
 if(g.kind==="forest"){const c=g.vals["hansen.tree_cover_2000"],l=g.vals["hansen.loss_year"].map(lossYear),forest=c.map(v=>v!=null&&v>=10);
  const nf=forest.filter(Boolean).length,after=l.filter((y,i)=>forest[i]&&y&&y>=2021).length,before=l.filter((y,i)=>forest[i]&&y&&y<2021).length;
  f.push(`${nf} of ${c.filter(v=>v!=null).length} squares were forest in 2000 (canopy ≥ 10 %)`);
  f.push(`forest lost before the EU cut-off (31 Dec 2020): ${before} squares; after it: ${after} squares${after?" — these would need due diligence":""}`);
  const a=g.extra.alert;if(a)f.push(`deforestation alert at the centre: ${fmt(a.value)} (${a.output_key||"alert_score"}${a.degraded?", half the composite: "+String(a.degraded_reason||"").replace(/_/g," "):""})`)}
 return f};

// maps: one canvas per band, a colour per value; empty squares stay empty
const RAMP={green:[[120,86,50],[214,196,120],[60,140,60],[18,80,30]],heat:[[40,70,160],[250,230,120],[230,90,40],[150,20,20]],ink:[[245,243,238],[160,160,150],[40,40,36]],loss:[[70,70,70],[255,200,80],[230,60,40]]};
const col=(ramp,t)=>{const r=RAMP[ramp],x=Math.max(0,Math.min(1,t))*(r.length-1),i=Math.min(r.length-2,Math.floor(x)),f=x-i;return r[i].map((v,k)=>Math.round(v+(r[i+1][k]-v)*f))};
export const paintGrid=g=>{
 if(typeof document==="undefined")return[];
 const out=PRESETS[g.kind].maps.map(([b,ramp,label])=>{const v=g.vals[b],S=240,s=S/g.n,cv=document.createElement("canvas");cv.width=S;cv.height=S+18;cv.className="preview grid-map";const c=cv.getContext("2d");
  c.fillStyle="#111";c.fillRect(0,0,S,S+18);const ok=v.filter(x=>x!=null),lo=Math.min(...ok),hi=Math.max(...ok);
  v.forEach((x,i)=>{if(x==null)return;let t=(x-lo)/(hi-lo||1);if(ramp==="loss"){const y=lossYear(x);if(!y)return;t=y>=2021?1:.45}c.fillStyle=`rgb(${col(ramp,t)})`;c.fillRect((i%g.n)*s,Math.floor(i/g.n)*s,s-1,s-1)});
  c.fillStyle="#fff";c.font="11px ui-monospace,monospace";c.fillText(label,4,S+13);return cv});
 const B=g.extra.buildings,feats=B?.features||B?.geojson?.features||[];
 if(feats.length){const S=240,cv=document.createElement("canvas");cv.width=S;cv.height=S+18;cv.className="preview grid-map";const c=cv.getContext("2d"),d=g.extra.box,k=Math.cos(g.p.lat*Math.PI/180);
  c.fillStyle="#f4f3ee";c.fillRect(0,0,S,S);c.fillStyle="#111";c.fillRect(0,S,S,18);c.fillStyle="#2f2f2a";c.strokeStyle="#2f2f2a";
  const X=lng=>(lng-(g.p.lng-d/k))/(2*d/k)*S,Y=lat=>((g.p.lat+d)-lat)/(2*d)*S;
  for(const f of feats){const rings=f.geometry?.type==="Polygon"?[f.geometry.coordinates[0]]:f.geometry?.type==="MultiPolygon"?f.geometry.coordinates.map(p=>p[0]):[];
   for(const ring of rings){c.beginPath();ring.forEach(([x,y],i)=>i?c.lineTo(X(x),Y(y)):c.moveTo(X(x),Y(y)));c.closePath();c.fill()}}
  c.fillStyle="#fff";c.font="11px ui-monospace,monospace";c.fillText(`${B.count} buildings`,4,S+13);out.push(cv)}
 return out;
};

export const gridNote=g=>{
 const F=findings(g),P=PRESETS[g.kind],okS=g.signed.filter(x=>x===true).length,have=g.cells.filter(Boolean).length;
 const rows=g.cells.map((c,i)=>c?`| ${Math.floor(i/g.n)},${i%g.n} | ${c} | ${g.bands.map(b=>g.vals[b][i]==null?"—":String(g.vals[b][i])).join(" | ")} |`:null).filter(Boolean);
 return`---\nemem: grid.v1\nkind: ${g.kind}\nplace: ${g.p.label}\nat: ${g.p.lat.toFixed(5)}, ${g.p.lng.toFixed(5)}\ngrid: ${g.n}×${g.n} squares, ${Math.round(P.span*2*111)} km across\nbands: ${g.bands.join(" ")}\n${g.bundles.map((t,i)=>t?`bundle ${g.bands[i]}: ${t}\n`:"").join("")}receipts: ${okS} of ${have} squares checked against the pinned key\n---\n\n# ${g.p.label}, ${g.kind==="city"?"as a city":"its forest"}, square by square\n\n${F.map(x=>"- "+x).join("\n")}\n\n## Squares\n\n| row,col | cell | ${g.bands.join(" | ")} |\n|---|---|${g.bands.map(()=>"---").join("|")}|\n${rows.join("\n")}\n`;
};

// a grid reopened: its values from the note, its bundles resolved and their signatures checked
export const gridFromNote=body=>{const k=(x)=>(body.match(new RegExp(`^${x}: (.+)$`,"m"))||[])[1]||"",kind=k("kind"),bands=k("bands").split(/\s+/),n=+(k("grid").match(/^(\d+)/)||[])[1]||12;
 const [lat,lng]=k("at").split(",").map(Number),cells=new Array(n*n).fill(null),vals=Object.fromEntries(bands.map(b=>[b,new Array(n*n).fill(null)]));
 for(const m of body.matchAll(/^\| (\d+),(\d+) \| (\S+) \| (.+) \|$/gm)){const i=+m[1]*n+ +m[2];cells[i]=m[3];m[4].split(" | ").forEach((v,j)=>{if(bands[j])vals[bands[j]][i]=v.trim()==="—"?null:Number(v)})}
 return{kind,bands,n,cells,vals,p:{lat,lng,label:k("place")},extra:{},bundles:bands.map(b=>k(`bundle ${b}`)||null)}};
