// point.mjs: name large data where it lives. Only the address and its proofs go to emem; the bytes stay at the source.
//
// A pointer is a small signed note: the source URL, its size, how it is cut into chunks, the BLAKE3 hash of every chunk
// it read, and one Merkle root over them. An agent later reads only the byte range it needs, from the source, and checks
// it against that chunk's hash. A chunk is whatever the format already treats as a unit: a raster tile, a Zarr chunk,
// a video segment, a tensor, a DICOM pixel block; otherwise a fixed 4 MiB range.
//
// Coverage grows by reading, never by trust: a later run hashes more chunks and writes a new pointer that names the one
// it extends. Which chunks come next is fixed by the order of H(label), so any two readers extend to the same chunks
// and their pointers can be compared row by row.
import {U,b32,net,pool} from "./emem.mjs";
const blake3=globalThis.ememCrypto.blake3;
const H=u=>b32(blake3(u)); // full 256-bit hash for data integrity; names stay 128-bit, chunk hashes do not truncate

// ---------- bytes from the source, never more than asked ----------
const range=async(url,from,len)=>{
 if(len<=0)return new Uint8Array(0);
 const x=await net(url,{headers:{range:`bytes=${from}-${from+len-1}`}});
 if(x.status===200){const n=+x.headers.get("content-length")||0;if(n>len*2&&n>8e6)throw new Error(`${new URL(url).host} ignores byte ranges, so it cannot be read in place.`)}
 else if(x.status!==206)throw new Error(`${url} answered ${x.status}.`);
 const b=new Uint8Array(await x.arrayBuffer());return x.status===200?b.slice(from,from+len):b;
};
const whole=async url=>{const x=await net(url);if(!x.ok)throw Object.assign(new Error(`${url} answered ${x.status}.`),{status:x.status});return new Uint8Array(await x.arrayBuffer())};
// size from HEAD; if the server hides it there, from the total in a one-byte range answer, when it exposes that
const size=async url=>{
 const x=await net(url,{method:"HEAD"}).catch(()=>null),n=+x?.headers.get("content-length")||0;
 if(x?.ok&&n)return{bytes:n,etag:x.headers.get("etag")};
 const y=await net(url,{headers:{range:"bytes=0-0"}}).catch(()=>null),t=+(y?.headers.get("content-range")||"").split("/")[1]||0;
 return{bytes:t||null,etag:y?.headers.get("etag")||null};
};

// ---------- the Merkle root: each leaf binds a chunk's position and length to its hash ----------
const u64=n=>{const b=new Uint8Array(8);new DataView(b.buffer).setBigUint64(0,BigInt(n));return b};
const cat=(...a)=>{const r=new Uint8Array(a.reduce((n,x)=>n+x.length,0));let i=0;for(const x of a){r.set(x,i);i+=x.length}return r};
const A="abcdefghijklmnopqrstuvwxyz234567",unb32=s=>{let b=0,v=0;const o=[];for(const c of s){v=(v<<5)|A.indexOf(c);b+=5;if(b>=8){o.push((v>>>(b-8))&255);b-=8}}return new Uint8Array(o)};
export const leaf=c=>blake3(cat(U(c.url||""),u64(c.offset),u64(c.length),unb32(c.hash)));
export const root=chunks=>{let l=chunks.map(leaf);if(!l.length)return"";while(l.length>1){const n=[];for(let i=0;i<l.length;i+=2)n.push(i+1<l.length?blake3(cat(l[i],l[i+1])):l[i]);l=n}return b32(l[0])};
// a feed is a chain instead: each link hashes the previous link with the next segment, so a later run can only extend it
export const chain=chunks=>chunks.reduce((p,c)=>b32(blake3(cat(unb32(p),unb32(c.hash)))),b32(new Uint8Array(32)));
const spread=(n,k)=>n<=k?[...Array(n).keys()]:[...Array(k).keys()].map(i=>Math.round(i*(n-1)/(k-1)));
export const mb=n=>n>=1e9?(n/1e9).toFixed(2)+" GB":n>=1e6?(n/1e6).toFixed(1)+" MB":(n/1e3).toFixed(1)+" KB";
const ZERO=b32(new Uint8Array(32));
// the part of a label that names the unit, without its type or shape,
// and without a wrapper prefix some exports add (transformer., model.), so the same tensor in two models lines up
export const keyOf=label=>label.replace(/\s+(F|BF|I|U|Q|IQ)[0-9A-Z_]*\[[\d,]*\]$/,"").replace(/^tensor (transformer|model|base_model\.model)\./,"tensor ").trim();
const order=label=>H(U(keyOf(label)));
const firstBy=(xs,label,n)=>new Set(xs.map(x=>[order(label(x)),x]).sort((a,b)=>a[0]<b[0]?-1:1).slice(0,n).map(p=>p[1]));

// ---------- statistics of a chunk, from its own bytes: mean, spread, range ----------
const g4=n=>+n.toPrecision(4);
const moments=(v,skip)=>{let n=0,s=0,q=0,lo=Infinity,hi=-Infinity;for(let i=0;i<v.length;i++){const x=v[i];if(x!==x||x===skip)continue;n++;s+=x;q+=x*x;if(x<lo)lo=x;if(x>hi)hi=x}
 if(!n)return"no valid values";const m=s/n;return`mean ${g4(m)} · sd ${g4(Math.sqrt(Math.max(0,q/n-m*m)))} · min ${g4(lo)} · max ${g4(hi)}${skip!=null&&n<v.length?` · ${Math.round(100*n/v.length)}% valid`:""}`};
const f16=h=>{const s=h&0x8000?-1:1,e=(h>>10)&31,f=h&1023;return e===0?s*f*2**-24:e===31?(f?NaN:s*Infinity):s*(1+f/1024)*2**(e-15)};
const floats=(b,dtype)=>{const dv=new DataView(b.buffer,b.byteOffset,b.byteLength);
 if(dtype==="F32"){const n=b.byteLength>>2;return b.byteOffset%4?Float32Array.from({length:n},(_,i)=>dv.getFloat32(i*4,true)):new Float32Array(b.buffer,b.byteOffset,n)}
 if(dtype==="F16"){const n=b.byteLength>>1,o=new Float32Array(n);for(let i=0;i<n;i++)o[i]=f16(dv.getUint16(i*2,true));return o}
 if(dtype==="BF16"){const n=b.byteLength>>1,o=new Float32Array(n),t=new DataView(new ArrayBuffer(4));for(let i=0;i<n;i++){t.setUint32(0,dv.getUint16(i*2,true)<<16);o[i]=t.getFloat32(0)}return o}
 return null};
const tensorStats=dtype=>/^(F32|F16|BF16)$/.test(dtype)?b=>{const v=floats(b,dtype);return v?moments(v):""}:null;
const inflate=async b=>new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
// a compressed raster tile: inflate it, undo horizontal differencing, then measure its pixels (nodata left out)
const tileStats=l=>(l.comp===8||l.comp===32946||l.comp===1)&&l.bits<=32&&globalThis.DecompressionStream?async b=>{
 const raw=l.comp===1?b:await inflate(b),dv=new DataView(raw.buffer,raw.byteOffset,raw.byteLength),n=raw.length/(l.bits/8)|0,le=l.le,v=new Float64Array(n);
 for(let i=0;i<n;i++)v[i]=l.fmt===3?(l.bits===64?dv.getFloat64(i*8,le):dv.getFloat32(i*4,le)):l.bits===8?raw[i]:l.bits===16?(l.fmt===2?dv.getInt16(i*2,le):dv.getUint16(i*2,le)):(l.fmt===2?dv.getInt32(i*4,le):dv.getUint32(i*4,le));
 if(l.pred===2){const w=l.tw*(l.spp||1),m=2**l.bits;for(let r=0;r*w<n;r++)for(let i=r*w+(l.spp||1);i<Math.min((r+1)*w,n);i++){v[i]=v[i]+v[i-(l.spp||1)];if(l.fmt!==3)v[i]=l.fmt===2?((v[i]+m/2)%m+m)%m-m/2:(v[i]%m+m)%m}}
 return moments(v,l.nodata)}:null;

// ---------- where a raster is: its projected centre and corners back to latitude and longitude (WGS84) ----------
export const utm2ll=(E,N,zone,south)=>{
 const a=6378137,f=1/298.257223563,k0=.9996,e2=f*(2-f),ep2=e2/(1-e2),x=E-5e5,y=south?N-1e7:N;
 const mu=y/k0/(a*(1-e2/4-3*e2*e2/64-5*e2**3/256)),e1=(1-Math.sqrt(1-e2))/(1+Math.sqrt(1-e2));
 const p=mu+(3*e1/2-27*e1**3/32)*Math.sin(2*mu)+(21*e1*e1/16-55*e1**4/32)*Math.sin(4*mu)+(151*e1**3/96)*Math.sin(6*mu)+(1097*e1**4/512)*Math.sin(8*mu);
 const s=Math.sin(p),c=Math.cos(p),t=Math.tan(p),N1=a/Math.sqrt(1-e2*s*s),T=t*t,C=ep2*c*c,R=a*(1-e2)/(1-e2*s*s)**1.5,D=x/(N1*k0);
 const lat=p-(N1*t/R)*(D*D/2-(5+3*T+10*C-4*C*C-9*ep2)*D**4/24+(61+90*T+298*C+45*T*T-252*ep2-3*C*C)*D**6/720);
 const lng=(D-(1+2*T+C)*D**3/6+(5-2*C+28*T-3*C*C+8*ep2+24*T*T)*D**5/120)/c;
 return[lat*180/Math.PI,(zone-1)*6-177+lng*180/Math.PI];
};
const toLL=(x,y,epsg)=>epsg===4326?[y,x]:epsg===3857?[(2*Math.atan(Math.exp(y/6378137))-Math.PI/2)*180/Math.PI,x/6378137*180/Math.PI]:epsg>=32601&&epsg<=32660?utm2ll(x,y,epsg-32600,false):epsg>=32701&&epsg<=32760?utm2ll(x,y,epsg-32700,true):null;

// ---------- TIFF, BigTIFF and cloud-optimised GeoTIFF: tiles at every level ----------
const tiff=async(url,tick)=>{
 const head=await range(url,0,65536),dv0=new DataView(head.buffer),le=dv0.getUint16(0)===0x4949,ver=dv0.getUint16(2,le);
 if(ver!==42&&ver!==43)throw new Error("Not a TIFF (no 42 or 43 after the byte order).");
 const big=ver===43,ES=big?20:12,CS=big?8:2,OS=big?8:4;
 const at=async(o,n)=>{if(o+n>head.length){const more=await range(url,o,n);return new DataView(more.buffer)}return new DataView(head.buffer,o,n)};
 const off=(d,o)=>big?Number(d.getBigUint64(o,le)):d.getUint32(o,le);
 const SIZE={1:1,2:1,3:2,4:4,5:8,6:1,7:1,8:2,9:4,10:8,11:4,12:8,16:8,17:8,18:8};
 const levels=[];let ifd=off(dv0,big?8:4),geo=null,scale=null,tie=null,nodata=null;
 while(ifd&&levels.length<16){
  const d=await at(ifd,CS),n=big?Number(d.getBigUint64(0,le)):d.getUint16(0,le),e=await at(ifd+CS,n*ES+OS),tags={};
  for(let i=0;i<n;i++){const t=e.getUint16(i*ES,le),ty=e.getUint16(i*ES+2,le),cnt=off(e,i*ES+4),sz=(SIZE[ty]||1)*cnt,vo=i*ES+4+OS;
   const read=async()=>{const v=sz<=OS?new DataView(e.buffer,e.byteOffset+vo,OS):await at(off(e,vo),sz),o=[];
    if(ty===2)return[new TextDecoder().decode(new Uint8Array(v.buffer,v.byteOffset,sz)).replace(/\0/g,"").trim()];
    for(let k=0;k<cnt;k++)o.push(ty===3?v.getUint16(k*2,le):ty===4?v.getUint32(k*4,le):ty===12?v.getFloat64(k*8,le):ty===16?Number(v.getBigUint64(k*8,le)):v.getUint8(k));return o};
   if([256,257,258,259,277,317,322,323,324,325,339,33550,33922,34735,42113].includes(t))tags[t]=await read()}
  if(!tags[324])throw new Error("This TIFF is striped, not tiled; it is read as a plain file instead.");
  levels.push({w:tags[256][0],h:tags[257][0],tw:tags[322][0],th:tags[323][0],off:tags[324],len:tags[325],bits:tags[258]?.[0]||8,fmt:tags[339]?.[0]||1,comp:tags[259]?.[0]||1,pred:tags[317]?.[0]||1,spp:tags[277]?.[0]||1,le});
  if(tags[34735])geo=tags[34735];if(tags[33550])scale=tags[33550];if(tags[33922])tie=tags[33922];if(tags[42113]&&tags[42113][0]!=="")nodata=+tags[42113][0];
  ifd=off(await at(ifd+CS+n*ES,OS),0);tick(`level ${levels.length}`);
 }
 let epsg=null;if(geo)for(let i=4;i+3<geo.length;i+=4)if(geo[i]===3072||geo[i]===2048)epsg=geo[i+3];
 for(const l of levels)l.nodata=nodata;
 const L0=levels[0],total=levels.reduce((n,l)=>n+l.off.length,0);
 // where it is: the tie point and pixel size give the projected corners; the centre becomes a place on Earth
 let place=null;
 if(tie&&scale&&epsg){const[,,,X,Y]=tie,x1=X+L0.w*scale[0],y1=Y-L0.h*scale[1],c=toLL((X+x1)/2,(Y+y1)/2,epsg),p=[toLL(X,Y,epsg),toLL(x1,y1,epsg),toLL(X,y1,epsg),toLL(x1,Y,epsg)];
  if(c&&p.every(Boolean))place={lat:+c[0].toFixed(5),lng:+c[1].toFixed(5),bbox:[Math.min(...p.map(q=>q[1])),Math.min(...p.map(q=>q[0])),Math.max(...p.map(q=>q[1])),Math.max(...p.map(q=>q[0]))].map(v=>+v.toFixed(4))}}
 const firstTile=Math.min(...levels.flatMap(l=>l.off.filter(o=>o>0)));
 const all=[{label:"header and tile tables",offset:0,length:Math.min(firstTile,65536),dflt:true}];
 levels.forEach((l,li)=>{const across=Math.ceil(l.w/l.tw),dflt=new Set(l.off.length<=64?l.off.keys():spread(l.off.length,li===0?6:16)),stats=tileStats(l);
  l.off.forEach((o,k)=>{if(l.len[k])all.push({label:`level ${li} tile ${k%across},${Math.floor(k/across)}`,offset:o,length:l.len[k],dflt:dflt.has(k),stats})})});
 const COMP={1:"raw",5:"LZW",7:"JPEG",8:"deflate",32946:"deflate",50000:"zstd",34887:"LERC"};
 return{kind:big?"cloud-optimised BigTIFF":"cloud-optimised GeoTIFF",all,units:total+1,place,
  about:[`${L0.w}×${L0.h} px, ${L0.bits}-bit ${L0.fmt===3?"float":L0.fmt===2?"signed":"unsigned"}, ${COMP[L0.comp]||"compression "+L0.comp}${L0.pred===2?" with horizontal differencing":""} tiles of ${L0.tw}×${L0.th}`,
   `${levels.length} levels (${levels.map(l=>l.w).join(", ")} px wide), ${total} tiles in all`,epsg?`EPSG:${epsg}`:"",scale?`${scale[0]} ${epsg>=32601&&epsg<=32760||epsg===3857?"m":"map units"} per pixel`:"",nodata!=null?`nodata ${nodata}`:"",
   place?`centre ${place.lat}, ${place.lng}; bounds ${place.bbox.join(", ")} (west, south, east, north)`:""].filter(Boolean)};
};

// ---------- OME-Zarr: every level, its chunk grid, and the chunks themselves ----------
const zarr=async(url,tick)=>{
 const base=url.replace(/\/(\.zattrs|\.zgroup)?$/,"")+"/",zattrs=JSON.parse(new TextDecoder().decode(await whole(base+".zattrs")));
 const ms=zattrs.multiscales?.[0];if(!ms)throw new Error("No multiscales in .zattrs; this is not an OME-Zarr image.");
 const all=[{label:".zattrs",url:base+".zattrs",offset:0,length:0,dflt:true}],about=[],levels=[];let units=0;
 for(const d of ms.datasets){const za=JSON.parse(new TextDecoder().decode(await whole(base+d.path+"/.zarray")));levels.push({path:d.path,za});all.push({label:`${d.path}/.zarray`,url:base+d.path+"/.zarray",offset:0,length:0,dflt:true})}
 levels.forEach((l,li)=>{const grid=l.za.shape.map((s,i)=>Math.ceil(s/l.za.chunks[i])),n=grid.reduce((a,b)=>a*b,1),sep=l.za.dimension_separator||".";units+=n;
  const dflt=new Set(li===levels.length-1&&n<=128?[...Array(n).keys()]:spread(n,li===0?8:24));
  // a level with millions of chunks is listed by an even spread of 20,000; the rest are still addressable by index
  for(const k of n<=20000?[...Array(n).keys()]:[...new Set([...spread(n,20000),...dflt])].sort((a,b)=>a-b)){let r=k;const idx=grid.map(()=>0);for(let i=grid.length-1;i>=0;i--){idx[i]=r%grid[i];r=Math.floor(r/grid[i])}
   all.push({label:`level ${l.path} chunk ${idx.join(",")}`,url:base+l.path+"/"+idx.join(sep),offset:0,length:0,dflt:dflt.has(k)})}});
 const z0=levels[0].za,axes=(ms.axes||[]).map(a=>a.name||a);
 about.push(`${z0.shape.join("×")} (${axes.join(", ")||"axes unnamed"}), ${z0.dtype}, ${z0.compressor?.cname||z0.compressor?.id||"raw"} chunks of ${z0.chunks.join("×")}`,`${levels.length} levels, ${units} chunks in all`);
 const unit=(ms.axes||[]).find(a=>a.unit)?.unit;if(unit)about.push(`space in ${unit}`);
 return{kind:"OME-Zarr image",all,units:units+1+levels.length,about,whole:true};
};

// ---------- HLS video: segments in order, chained like a log, so a live feed extends and never rewrites ----------
const hls=async(url,tick)=>{
 let text=new TextDecoder().decode(await whole(url)),media=url;
 if(/#EXT-X-STREAM-INF/.test(text)){ // a master playlist: take the lightest variant
  const vs=[...text.matchAll(/#EXT-X-STREAM-INF:[^\n]*BANDWIDTH=(\d+)[^\n]*\n([^\n#][^\n]*)/g)].map(m=>({bw:+m[1],u:new URL(m[2].trim(),url).href})).sort((a,b)=>a.bw-b.bw);
  media=vs[0].u;text=new TextDecoder().decode(await whole(media));
 }
 const segs=[...text.matchAll(/#EXTINF:([\d.]+)[^\n]*\n([^\n#][^\n]*)/g)].map(m=>({dur:+m[1],u:new URL(m[2].trim(),media).href}));
 const live=!/#EXT-X-ENDLIST/.test(text);
 return{kind:live?"live HLS feed":"HLS video",all:[{label:"playlist",url:media,offset:0,length:0,dflt:true},...segs.map((s,i)=>({label:`segment ${i} · ${s.dur}s`,url:s.u,offset:0,length:0,dflt:i<120}))],units:segs.length+1,whole:true,chained:true,
  about:[`${segs.length} segments, ${Math.round(segs.reduce((a,s)=>a+s.dur,0))} s`,live?"live: running this again extends the chain; earlier links never change":"on demand (the playlist is closed)"]};
};

// ---------- DICOM: technical tags only; nothing that identifies a person is ever copied ----------
const TAGS={"00080060":"modality","00080070":"manufacturer","00280010":"rows","00280011":"columns","00280100":"bits allocated","00280103":"pixel representation","00280030":"pixel spacing","00180050":"slice thickness","00281052":"rescale intercept","00281053":"rescale slope","00020010":"transfer syntax"};
const US=/^002800(10|11)|^00280100|^00280103/;
const dicom=async(url,tick)=>{
 const b=await whole(url);if(new TextDecoder().decode(b.slice(128,132))!=="DICM")throw new Error("Not a DICOM file (no DICM marker).");
 const dv=new DataView(b.buffer),found={};let o=132,pixel=null,explicit=true;
 const long=new Set(["OB","OW","OF","SQ","UT","UN","OD","OL","UC","UR"]);
 while(o+8<=b.length){
  const g=dv.getUint16(o,true),e=dv.getUint16(o+2,true),tag=g.toString(16).padStart(4,"0")+e.toString(16).padStart(4,"0");
  const ex=g===2||explicit;let vr="",len,start;
  if(ex){vr=String.fromCharCode(b[o+4],b[o+5]);if(long.has(vr)){len=dv.getUint32(o+8,true);start=o+12}else{len=dv.getUint16(o+6,true);start=o+8}}
  else{len=dv.getUint32(o+4,true);start=o+8}
  if(tag==="7fe00010"){pixel={offset:start,length:len===0xffffffff?b.length-start:len,encap:len===0xffffffff};break}
  if(len===0xffffffff)throw new Error("This DICOM uses nested sequences of undefined length; it is read as a plain file instead.");
  if(TAGS[tag]&&g!==0x0010){const v=new TextDecoder().decode(b.slice(start,start+len)).replace(/\0/g,"").trim();found[TAGS[tag]]=vr==="US"||(!ex&&US.test(tag))?String(dv.getUint16(start,true)):v}
  if(tag==="00020010")explicit=!/^1\.2\.840\.10008\.1\.2\0?$/.test(found["transfer syntax"]||"");
  o=start+len;
 }
 if(!pixel)throw new Error("No pixel data found.");
 // uncompressed 16-bit pixels are measured; with a rescale, in the stored unit (Hounsfield units for CT)
 const ts=found["transfer syntax"]||"",raw=!pixel.encap&&/^1\.2\.840\.10008\.1\.2(\.1)?$/.test(ts)&&found["bits allocated"]==="16";
 const slope=+found["rescale slope"]||1,icpt=+found["rescale intercept"]||0,signed=found["pixel representation"]==="1",hu=found.modality==="CT"&&("rescale intercept" in found);
 const stats=raw?c=>{const d=new DataView(c.buffer,c.byteOffset,c.byteLength),n=c.length>>1,v=new Float64Array(n);for(let i=0;i<n;i++)v[i]=(signed?d.getInt16(i*2,true):d.getUint16(i*2,true))*slope+icpt;return moments(v)+(hu?" HU":"")}:null;
 const all=[{label:"header (technical and identifying tags stay at the source)",offset:0,length:pixel.offset,dflt:true}];
 for(let p=0;p<pixel.length;p+=1<<20)all.push({label:`pixel data ${all.length}`,offset:pixel.offset+p,length:Math.min(1<<20,pixel.length-p),dflt:true,stats});
 return{kind:"DICOM image",all,units:all.length,bytes:b,
  about:[[found.modality,found.manufacturer].filter(Boolean).join(" · ")||"DICOM",found.rows&&found.columns?`${found.columns}×${found.rows} px, ${found["bits allocated"]||"?"}-bit ${signed?"signed":"unsigned"}`:"",found["pixel spacing"]?`pixel spacing ${found["pixel spacing"].split("\\").map(v=>+(+v).toFixed(3)).join(" × ")} mm`:"",found["slice thickness"]?`slice ${+(+found["slice thickness"]).toFixed(3)} mm`:"",raw?`pixel statistics per chunk${hu?", in Hounsfield units (rescale "+slope+"·v "+(icpt<0?"− "+-icpt:"+ "+icpt)+")":""}`:""].filter(Boolean)};
};

// ---------- model weights (safetensors): every tensor is a chunk, found by the file's own header ----------
const safetensors=async(url,tick)=>{
 const n=Number(new DataView((await range(url,0,8)).buffer).getBigUint64(0,true));if(n>50e6)throw new Error("safetensors header is implausibly large.");
 const head=await range(url,8,n),meta=JSON.parse(new TextDecoder().decode(head)),base=8+n;
 const ts=Object.entries(meta).filter(([k])=>k!=="__metadata__").map(([k,v])=>({k,dtype:v.dtype,shape:v.shape,o:base+v.data_offsets[0],len:v.data_offsets[1]-v.data_offsets[0]})).sort((a,b)=>a.o-b.o);
 const params=ts.reduce((a,t)=>a+t.shape.reduce((x,y)=>x*y,1),0),dtypes=[...new Set(ts.map(t=>t.dtype))];
 // small tensors (norms, biases) are all hashed; the header pins the whole layout either way
 // large ones are picked by H(name), not position, so two models sample the same tensors and can be compared
 const dfltBig=firstBy(ts.filter(t=>t.len>65536),t=>`tensor ${t.k}`,8);
 return{kind:"model weights (safetensors)",units:ts.length+1,
  all:[{label:"header: every tensor's name, dtype, shape and byte range",offset:0,length:base,dflt:true},...ts.map(t=>({label:`tensor ${t.k} ${t.dtype}[${t.shape.join(",")}]`,offset:t.o,length:t.len,dflt:t.len<=65536||dfltBig.has(t),stats:tensorStats(t.dtype)}))],
  about:[`${ts.length} tensors, ${params.toLocaleString("en")} parameters, ${dtypes.join(", ")}`,"the header pins the layout of every tensor; each hashed tensor also carries its mean, spread and range",meta.__metadata__?`metadata: ${JSON.stringify(meta.__metadata__).slice(0,120)}`:""].filter(Boolean)};
};

// ---------- model weights (GGUF): the header lists every tensor's type, shape and offset ----------
// elements per block and bytes per block for each GGML type
const GGML={0:["F32",1,4],1:["F16",1,2],2:["Q4_0",32,18],3:["Q4_1",32,20],6:["Q5_0",32,22],7:["Q5_1",32,24],8:["Q8_0",32,34],9:["Q8_1",32,36],10:["Q2_K",256,84],11:["Q3_K",256,110],12:["Q4_K",256,144],13:["Q5_K",256,176],14:["Q6_K",256,210],15:["Q8_K",256,292],16:["IQ2_XXS",256,66],17:["IQ2_XS",256,74],18:["IQ3_XXS",256,98],19:["IQ1_S",256,50],20:["IQ4_NL",32,18],21:["IQ3_S",256,110],22:["IQ2_S",256,82],23:["IQ4_XS",256,136],24:["I8",1,1],25:["I16",1,2],26:["I32",1,4],27:["I64",1,8],28:["F64",1,8],29:["IQ1_M",256,56],30:["BF16",1,2]};
const gguf=async(url,tick,bytes)=>{
 // the header is read forward, fetching more only when the next field is not here yet
 let buf=new Uint8Array(0),p=0;
 const need=async n=>{while(p+n>buf.length){const more=await range(url,buf.length,Math.max(1<<20,p+n-buf.length));if(!more.length)throw new Error("GGUF header runs past the end of the file.");buf=cat(buf,more);tick(`header ${mb(buf.length)}`)}return new DataView(buf.buffer,p,n)};
 const u32=async()=>{const v=(await need(4)).getUint32(0,true);p+=4;return v},u64=async()=>{const v=Number((await need(8)).getBigUint64(0,true));p+=8;return v};
 const str=async()=>{const n=await u64();if(n>1e7)throw new Error("GGUF string is implausibly long.");await need(n);const s=new TextDecoder().decode(buf.subarray(p,p+n));p+=n;return s};
 const SZ={0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,10:8,11:8,12:8};
 const val=async t=>{if(t===8)return str();if(t===9){const et=await u32(),n=await u64();if(et===8){for(let i=0;i<n;i++)await str()}else{await need(SZ[et]*n);p+=SZ[et]*n}return{array:n}}
  const d=await need(SZ[t]);p+=SZ[t];return t===0?d.getUint8(0):t===1?d.getInt8(0):t===2?d.getUint16(0,true):t===3?d.getInt16(0,true):t===4?d.getUint32(0,true):t===5?d.getInt32(0,true):t===6?d.getFloat32(0,true):t===7?!!d.getUint8(0):t===12?d.getFloat64(0,true):Number(d.getBigUint64(0,true))};
 if(new TextDecoder().decode((await need(4),buf.subarray(0,4)))!=="GGUF")throw new Error("Not a GGUF file (no GGUF magic).");p=4;
 const ver=await u32();if(ver<2)throw new Error("GGUF version 1 is not read in place.");
 const nt=await u64(),nkv=await u64(),kv={};
 for(let i=0;i<nkv;i++){const k=await str(),t=await u32();kv[k]=await val(t)}
 const ts=[];for(let i=0;i<nt;i++){const name=await str(),nd=await u32(),dims=[];for(let j=0;j<nd;j++)dims.push(await u64());ts.push({name,dims,type:await u32(),off:await u64()})}
 const align=kv["general.alignment"]||32,base=Math.ceil(p/align)*align;
 ts.sort((a,b)=>a.off-b.off);
 ts.forEach((t,i)=>{const g=GGML[t.type],n=t.dims.reduce((a,b)=>a*b,1);t.dt=g?.[0]||"type"+t.type;t.len=g?n/g[1]*g[2]:(ts[i+1]?.off??(bytes-base))-t.off;t.n=n});
 const params=ts.reduce((a,t)=>a+t.n,0),types=[...new Set(ts.map(t=>t.dt))],arch=kv["general.architecture"];
 const dfltBig=firstBy(ts.filter(t=>t.len>65536),t=>`tensor ${t.name}`,8);
 const k=s=>kv[`${arch}.${s}`];
 return{kind:"model weights (GGUF)",units:ts.length+1,
  all:[{label:"header: metadata, vocabulary, and every tensor's type, shape and offset",offset:0,length:base,dflt:true},...ts.map(t=>({label:`tensor ${t.name} ${t.dt}[${t.dims.join(",")}]`,offset:base+t.off,length:t.len,dflt:t.len<=65536||dfltBig.has(t),stats:tensorStats(t.dt)}))],
  about:[[kv["general.name"],arch].filter(Boolean).join(" · ")||"GGUF",`${ts.length} tensors, ${params.toLocaleString("en")} parameters, ${types.join(", ")}`,
   [k("block_count")&&`${k("block_count")} layers`,k("embedding_length")&&`width ${k("embedding_length")}`,k("context_length")&&`context ${k("context_length")}`,kv["tokenizer.ggml.tokens"]?.array&&`vocabulary ${kv["tokenizer.ggml.tokens"].array}`].filter(Boolean).join(", "),
   `GGUF v${ver}, ${Object.keys(kv).length} metadata keys, tensors aligned to ${align} bytes`].filter(Boolean)};
};

// ---------- a source that hides its size: stream it once, hashing 4 MiB at a time as it passes; none of it is kept ----------
const stream=async(url,tick)=>{
 const x=await net(url);if(!x.ok)throw new Error(`${url} answered ${x.status}.`);
 const rd=x.body.getReader(),C=4<<20,all=[];let buf=new Uint8Array(0),off=0;
 const flush=part=>{all.push({label:`bytes ${off}…`,offset:off,length:part.length,hash:H(part),dflt:true});off+=part.length};
 for(;;){const{done,value}=await rd.read();if(value){buf=cat(buf,value);while(buf.length>=C){flush(buf.slice(0,C));buf=buf.slice(C)}tick(`${(off/1e6).toFixed(0)} MB hashed`)}if(off>1e9){rd.cancel();throw new Error("Over 1 GB with no size or byte ranges; this source cannot be pointed at from a browser.")}if(done)break}
 if(buf.length)flush(buf);
 return{kind:"file",all,units:all.length,bytes:off,streamed:true,about:[`${all.length} ranges of 4 MiB, read once as a stream`]};
};

// ---------- anything else: fixed ranges ----------
const file=async(url,tick,n)=>{
 const C=4<<20,count=Math.ceil(n/C),dflt=new Set(n<=256e6?[...Array(count).keys()]:spread(count,32));
 return{kind:"file",all:[...Array(count).keys()].map(k=>({label:`bytes ${k*C}…`,offset:k*C,length:Math.min(C,n-k*C),dflt:dflt.has(k)})),units:count,about:[`${count} ranges of 4 MiB`]};
};

const pick=u=>/\.safetensors(\?|$)/i.test(u)?safetensors:/\.gguf(\?|$)/i.test(u)?gguf:/\.m3u8(\?|$)/i.test(u)?hls:/\.zarr(\/|$)/i.test(u)?zarr:/\.dcm(\?|$)/i.test(u)?dicom:/\.tiff?(\?|$)/i.test(u)?tiff:null;
export const POINTABLE=/^(point:\s*)?https?:\/\/\S+?(\.m3u8|\.zarr\/?|\.dcm|\.safetensors|\.gguf|\.tiff?|\.nc|\.h5|\.hdf5|\.las|\.laz|\.parquet|\.mp4|\.mov|\.bin|\.zip)(\?\S*)?$|^point:\s*https?:\/\/\S+$/i;

// the rows of a pointer's table, with the optional stats column
export const parseRows=body=>[...body.matchAll(/^\| ([^|]+) \| (\S+) \| (\d+) \| (\d+) \| ([^|]+) \|(?: ([^|]*) \|)?$/gm)].filter(m=>m[1]!=="what"&&!/^-+$/.test(m[1])).map(m=>{const h=m[5].trim();return{label:m[1].trim(),url:m[2]==="·"?"":m[2],offset:+m[3],length:+m[4],hash:/^[a-z2-7]{52}$/.test(h)?h:ZERO,absent:!/^[a-z2-7]{52}$/.test(h),stats:(m[6]||"").trim()}});
const field=(body,k)=>(body.match(new RegExp(`^${k}: (.+)$`,"m"))||[])[1];

// read the structure, hash the chosen chunks from the source, and write the pointer's text
//  opts.have        an earlier pointer's text: its rows are kept (two are re-read to be sure), and it is named as extended
//  opts.more        how many more chunks to hash beyond the defaults, in H(label) order
//  opts.placeAbout  async ({lat,lng,bbox}) -> lines, to say where a raster is in emem's own terms
export const probe=async(raw,tick,opts={})=>{
 const url=raw.replace(/^point:\s*/i,"").trim(),host=new URL(url).host;
 tick("reading structure");
 const {bytes,etag}=await size(url).catch(()=>({}));
 let s;try{s=await(pick(url)||(()=>{throw new Error("plain")}))(url,tick,bytes)}catch(e){if(e.message!=="plain"&&!/read as a plain file/.test(e.message))throw e;s=bytes?await file(url,tick,bytes):await stream(url,tick)}
 // which chunks: the defaults, whatever the earlier pointer already had, then the next ones in a fixed order anyone can repeat
 const prev=opts.have?parseRows(opts.have):[],had=new Map(prev.map(r=>[r.label,r]));
 if(opts.have){const pb=field(opts.have,"bytes");if(bytes&&/^\d+$/.test(pb||"")&&+pb!==bytes)throw new Error(`The source is now ${bytes} bytes; the pointer says ${pb}. It changed, so it is pointed at afresh, not extended.`)}
 const pickSet=new Set(s.all.filter(c=>c.dflt||had.has(c.label)));
 const more=Math.max(0,opts.more|0);
 if(more){const rest=s.all.filter(c=>!pickSet.has(c));(s.chained?rest:rest.map(c=>[order(c.label),c]).sort((a,b)=>a[0]<b[0]?-1:1).map(x=>x[1])).slice(0,more).forEach(c=>pickSet.add(c))}
 const chunks=s.all.filter(c=>pickSet.has(c));
 // rows carried over from the earlier pointer are not re-read, except a spread of two, which must still match
 const carried=chunks.filter(c=>had.has(c.label)&&!had.get(c.label).absent);
 for(const i of spread(carried.length,2)){const c=carried[i],r=had.get(c.label),b=c.url?await whole(c.url):await range(url,r.offset,r.length);if(H(b)!==r.hash)throw new Error(`${c.label} no longer matches the pointer being extended; the source changed.`)}
 for(const c of carried){const r=had.get(c.label);Object.assign(c,{hash:r.hash,length:r.length,statsText:r.stats,kept:true})}
 let done=0,read=0;
 await pool(chunks,6,async c=>{
  if(c.hash){done++;if(!c.kept)read+=c.length;return}
  const b=s.bytes&&!c.url?s.bytes.slice(c.offset,c.offset+c.length):c.url?await whole(c.url).catch(e=>e.status===404?null:Promise.reject(e)):await range(url,c.offset,c.length);
  if(b===null){c.absent=true;c.hash=ZERO;c.length=0}else{c.hash=H(b);if(c.url)c.length=b.length;read+=b.length;if(c.stats)c.statsText=await Promise.resolve(c.stats(b)).catch(()=>"")}
  tick(`${++done}/${chunks.length} chunks · ${mb(read)} read`);
 });
 for(const c of chunks)if(c.url===url)c.url="";
 let total=s.streamed?s.bytes:s.whole?null:bytes,est=null;
 if(s.whole){const got=chunks.filter(c=>!c.absent&&/chunk|segment/.test(c.label));if(got.length)est=Math.round(got.reduce((a,c)=>a+c.length,0)/got.length*(s.units-s.all.filter(c=>!/chunk|segment/.test(c.label)).length))}
 const place=s.place&&opts.placeAbout?await opts.placeAbout(s.place).catch(()=>[]):[];
 // a row at the source itself is written "·" and hashed with an empty url
 const r=s.chained?chain(chunks):root(chunks),name=decodeURIComponent(url.split("/").filter(Boolean).pop()||host),withStats=chunks.some(c=>c.statsText);
 const rows=chunks.map(c=>`| ${c.label} | ${c.url&&c.url!==url?c.url:"·"} | ${c.offset} | ${c.length} | ${c.absent?"absent (fill value)":c.hash} |${withStats?` ${(c.statsText||"").replace(/\|/g,"/")} |`:""}`);
 const prevCid=opts.have?(opts.haveUrl||"").split("/").pop().replace(/\.md$/,""):"";
 const body=`---\nemem: pointer.v1\nsource: ${url}\nbytes: ${total??(est?`about ${est} (estimated from the chunks read)`:"unknown")}\netag: ${etag||"not exposed"}\nkind: ${s.kind}\nchunks: ${chunks.length} of ${s.units} hashed\n${s.chained?"chain":"root"}: ${r}\nhash: blake3-256 of each chunk's bytes\norder: defaults, then by blake3(label without type or shape)\n${prevCid?`extends: ${prevCid}\n`:""}${s.place?`place: ${s.place.lat},${s.place.lng}\nbbox: ${s.place.bbox.join(",")}\n`:""}---\n\n# ${name}\n\n> ${s.kind} at ${host}${total?`, ${mb(total)}`:est?`, about ${mb(est)}`:""}. The data stays there; this note is its address and its proofs. Read any chunk from the source by URL and byte range, then check its BLAKE3 hash below. ${s.chained?"Each link of the chain hashes the previous link with the next segment.":"The root is a Merkle tree over (url, offset, length, hash) of every row, in order."}\n\n${s.about.map(a=>"- "+a).join("\n")}\n- ${chunks.length} of ${s.units} chunks hashed${prevCid?`; extends ${prevCid}, whose ${carried.length} rows are kept and 2 of them re-read`:""}; more can be hashed later, in a fixed order, without re-reading these\n${place.length?`\n## Place\n\n${place.map(a=>"- "+a).join("\n")}\n`:""}\n## Chunks\n\n| what | url (· is the source) | offset | length | blake3 |${withStats?" stats |":""}\n|---|---|---|---|---|${withStats?"---|":""}\n${rows.join("\n")}\n`;
 return{body,url,name,kind:s.kind,bytes:total,est,read,chunks,units:s.units,rootHash:r,chained:!!s.chained,about:s.about,place:s.place};
};

// re-read a spread of chunks from the source and compare: is the data still what the pointer says?
export const recheck=async(body,tick,k=6)=>{
 const src=field(body,"source"),want=(body.match(/^(root|chain): (\S+)/m)||[]),all=parseRows(body),chunks=all.filter(c=>!c.absent);
 const table=want[1]==="chain"?chain(all)===want[2]:root(all)===want[2];
 let ok=0,n=0;const rows=[];
 for(const i of spread(chunks.length,k)){const c=chunks[i];const b=c.url?await whole(c.url):await range(src,c.offset,c.length);n++;const now=H(b),good=now===c.hash;if(good)ok++;rows.push({...c,now,ok:good});tick(`${n}/${Math.min(k,chunks.length)} from the source`)}
 return{src,table,ok,n,rows};
};

// two pointers side by side: which units are byte-identical, which differ (with their statistics), which only one has
export const compare=(a,b)=>{
 const ra=new Map(parseRows(a).map(r=>[keyOf(r.label),r])),rb=new Map(parseRows(b).map(r=>[keyOf(r.label),r]));
 const same=[],changed=[],onlyA=[],onlyB=[];
 for(const[k,x]of ra){const y=rb.get(k);if(!y)onlyA.push(x);else if(x.hash===y.hash)same.push({key:k,a:x,b:y});else changed.push({key:k,a:x,b:y})}
 for(const[k,y]of rb)if(!ra.has(k))onlyB.push(y);
 return{same,changed,onlyA,onlyB,a:{source:field(a,"source"),kind:field(a,"kind"),chunks:field(a,"chunks")},b:{source:field(b,"source"),kind:field(b,"kind"),chunks:field(b,"chunks")}};
};

// one row re-read from its source, hashed the same way
export const reread=async(src,c)=>H(c.url?await whole(c.url):await range(src,c.offset,c.length));
