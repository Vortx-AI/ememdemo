// world.mjs: one place, every layer emem.dev measures there, as signed facts and one handle.
//
// A place becomes a cell about 10 m across. At that cell emem recalls each layer (optical and radar satellites, terrain,
// weather, climate, air, the built world), runs the published algorithms whose inputs are present, derives terrain
// indices from the 3×3 elevation neighbourhood, and mints a cloud-masked median composite of the surrounding square.
// Every answer carries a receipt; each is checked here against the signer pinned in emem.eio. The facts are then bound
// into one emem:bundle token, and the whole reading is stored as one hash-named note.
import {EMEM,net,post,json,fmt,day,grid,receiptOk} from "./emem.mjs";

// the layers, in the order a person reads a place: what it looks like, what it is made of, what it is like to be there
export const LAYERS=[
 ["satellite, optical (Sentinel-2)",{"s2.B04":"red reflectance","s2.B08":"near-infrared reflectance","indices.ndvi":"vegetation index (NDVI)"}],
 ["satellite, radar (Sentinel-1: through cloud, day or night)",{"sentinel1_raw":"VV backscatter"}],
 ["terrain",{"copdem30m.elevation_mean":"ground elevation (Copernicus DEM)","gmrt.topobathy_mean":"topography and bathymetry (GMRT)"}],
 ["weather, now",{"weather.temperature_2m":"air temperature at 2 m","weather.precipitation_mm":"precipitation","weather.wind_speed_10m":"wind at 10 m"}],
 ["climate and surface heat",{"era5.t2m":"air temperature (ERA5 reanalysis)","modis.lst_day_8day":"land surface, day (MODIS, 8-day)","modis.lst_night_8day":"land surface, night (MODIS, 8-day)"}],
 ["vegetation across seasons",{"modis.ndvi_mean":"NDVI, 16-day composite (MODIS, 250 m)"}],
 ["air",{"cams.pm25":"fine particulate matter PM2.5 (CAMS)"}],
 ["the built world (Overture)",{"overture.buildings.count":"buildings in the cell","overture.places.count":"named places in the cell","overture.transportation.road_length_m":"road length in the cell"}]];
const BANDS=LAYERS.flatMap(([,b])=>Object.keys(b));
export const WORLD=/^world:\s*(.{2,120})$/i;

// the place, resolved once: a cell, its centre, and the name emem settled on
export const locate=async(q,tick)=>{
 tick("finding the place");
 const l=await json(await net(`${EMEM}/v1/locate?q=${encodeURIComponent(q)}`)),cell=l.cell64||l.cell;
 if(!cell)throw new Error(`emem.dev could not find "${q}". Name a town, a landmark, or give "lat, lng".`);
 return{q,cell,label:l.place_label||l.selected?.label||q,lat:l.centre?.lat_deg,lng:l.centre?.lng_deg};
};

// every layer at once; each call is independent, so one slow or missing layer never blocks the others
export const layers=async(p,S,tick)=>{
 tick(`reading ${BANDS.length} layers`);
 const d=.0045,bbox={min_lat:p.lat-d,min_lng:p.lng-d/Math.cos(p.lat*Math.PI/180),max_lat:p.lat+d,max_lng:p.lng+d/Math.cos(p.lat*Math.PI/180)};
 const end=new Date(),start=new Date(end-120*864e5),iso=t=>t.toISOString().slice(0,10);
 const [r,t,c]=await Promise.all([
  post(`${EMEM}/v1/recall`,{cell:p.cell,bands:BANDS}).then(json),
  post(`${EMEM}/v1/terrain`,{cell:p.cell}).then(json).catch(()=>null),
  post(`${EMEM}/v1/band_composite`,{bbox,band:"s2.B08",start_date:iso(start),end_date:iso(end)}).then(json).catch(()=>null)]);
 const latest={};for(const f of r.facts||[])if(f.value!=null&&f.value!=="")latest[f.band]=f; // facts arrive oldest first
 tick("checking every receipt");
 const [rOk,tOk,cOk]=await Promise.all([receiptOk(r.receipt,S.signer),t?receiptOk(t.receipt,S.signer):null,c?receiptOk(c.receipt,S.signer):null]);
 tick("one handle for all of it");
 const present=BANDS.filter(b=>latest[b]);
 const b=present.length?await post(`${EMEM}/v1/memory_bundle`,{triples:present.map(band=>({cell:p.cell,band})),purpose:`every layer at ${p.label}`}).then(json).catch(()=>null):null;
 const bOk=b?await receiptOk(b.receipt,S.signer):null;
 const art=c?.artifact?.artifact_cid?await grid(c.artifact.artifact_cid).catch(()=>null):null;
 return{...p,latest,algos:r.applicable_algorithms||[],missing:[...(r.unknown_bands||[]),...BANDS.filter(x=>!latest[x]&&!(r.unknown_bands||[]).includes(x))],
  terrain:t,composite:c,art,bundle:b?.bundle_token||null,checks:{recall:rOk,terrain:tOk,composite:cOk,bundle:bOk}};
};

// the reading, as a note: one line per measurement with its token, then what was derived from them and how
export const weave=w=>{
 const t=w.terrain,c=w.composite,ok=v=>v===true?"✓":v===false?"✗":"·",n=Object.keys(w.latest).length;
 const sections=LAYERS.map(([name,bands])=>{const rows=Object.entries(bands).filter(([k])=>w.latest[k]).map(([k,label])=>{const f=w.latest[k];return`- ${label} (${k}): ${fmt(f.value)}${f.unit?" "+f.unit:""} · ${f.memory_token}`});return rows.length?`## ${name}\n\n${rows.join("\n")}\n`:""}).filter(Boolean);
 const terrain=t?.slope?`## terrain, derived\n\n- slope ${fmt(t.slope.slope_deg)}° (Horn 1981), ruggedness ${fmt(t.ruggedness?.tri_m)} m (Riley 1999), position ${fmt(t.topo_position?.tpi_m)} m: ${String(t.topo_position?.landform_class||"").replace(/_/g," ")} (Weiss 2001)\n- from the 3×3 elevation neighbourhood at ${fmt(t.step_w_m)} m spacing; ${t.input_fact_cids?.length||0} elevation facts cited\n`:"";
 const comp=c?.tokens?.raster?`## composite\n\n- near-infrared (s2.B08), cloud-masked median of ${c.member_count} Sentinel-2 scenes, ${c.window?.start} to ${c.window?.end}, ${c.grid?.width}×${c.grid?.height} px at ${c.grid?.native_m} m (EPSG:${c.grid?.epsg})\n- the recipe, mask and every scene are pinned, so anyone can rebuild it pixel for pixel: ${c.tokens.raster}\n`:"";
 // independent sources for the same quantity, side by side: agreement is evidence, disagreement is a finding
 const fin=x=>Number.isFinite(x)?x:null,v=k=>w.latest[k]?fin(Number(w.latest[k].value)):null,cross=[];
 if(v("copdem30m.elevation_mean")!=null&&v("gmrt.topobathy_mean")!=null)cross.push(`- elevation: Copernicus DEM ${fmt(v("copdem30m.elevation_mean"))} m and GMRT ${fmt(v("gmrt.topobathy_mean"))} m, ${fmt(Math.abs(v("copdem30m.elevation_mean")-v("gmrt.topobathy_mean")))} m apart (a surface model includes canopy and buildings)`);
 if(v("s2.B04")!=null&&v("s2.B08")!=null){const nd=(v("s2.B08")-v("s2.B04"))/(v("s2.B08")+v("s2.B04"));cross.push(`- vegetation: NDVI recomputed here from red and near-infrared, (B08 − B04) / (B08 + B04) = ${fmt(nd)}; emem's stored index ${fmt(v("indices.ndvi"))}${v("modis.ndvi_mean")!=null?`; MODIS at 250 m ${fmt(v("modis.ndvi_mean"))}`:""} (scene dates and footprints differ)`)}
 const C=k=>{const f=w.latest[k];return f?fin(f.unit==="K"?Number(f.value)-273.15:Number(f.value)):null};
 if(C("weather.temperature_2m")!=null&&C("era5.t2m")!=null)cross.push(`- heat: air now ${fmt(C("weather.temperature_2m"))} °C (met.no), reanalysis ${fmt(C("era5.t2m"))} °C (ERA5)${C("modis.lst_day_8day")!=null?`, ground by day ${fmt(C("modis.lst_day_8day"))} °C`:""}${C("modis.lst_night_8day")!=null?`, ground by night ${fmt(C("modis.lst_night_8day"))} °C`:""}${C("modis.lst_day_8day")!=null||C("modis.lst_night_8day")!=null?" (MODIS, from kelvin)":""}`);
 const crossS=cross.length?`## cross-checks, independent sources\n\n${cross.join("\n")}\n\n`:"";
 const algos=w.algos.length?`## algorithms, run on these facts\n\n${w.algos.map(a=>`- ${a.algorithm_key}: ${a.formula} = ${typeof a.value==="number"?fmt(a.value):a.value}`).join("\n")}\n`:"";
 const body=`---\nemem: world.v1\nplace: ${w.label}\ncell: ${w.cell}\nat: ${w.lat?.toFixed(5)}, ${w.lng?.toFixed(5)}\nbundle: ${w.bundle||"none"}\n${c?.tokens?.raster?`composite: ${c.tokens.raster}\n`:""}receipts: recall ${ok(w.checks.recall)} · terrain ${ok(w.checks.terrain)} · composite ${ok(w.checks.composite)} · bundle ${ok(w.checks.bundle)} (checked against the pinned emem.dev key)\n---\n\n# ${w.label}, every layer\n\n> ${n} signed measurements from ${sections.length} layers at one place about 10 m across${w.bundle?`, bound into one handle: ${w.bundle}`:""}. Each token resolves to its signed fact. Nothing here is prose written about the place; every number is a measurement or a published formula over measurements.\n\n${sections.join("\n")}\n${terrain}\n${comp}\n${crossS}${algos}${w.missing.length?`\n## not measured here\n\n${w.missing.map(m=>"- "+m).join("\n")}\n`:""}`;
 return body;
};
