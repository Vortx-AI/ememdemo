// point.mjs: name large data where it lives. Only the address and its proofs go to emem; the bytes stay at the source.
//
// A pointer is a small signed note: the source URL, its size, how it is cut into chunks, the BLAKE3 hash of every chunk
// it read, and one Merkle root over them. An agent later reads only the byte range it needs, from the source, and checks
// it against that chunk's hash. A chunk is whatever the format already treats as a unit: a raster tile, a Zarr chunk,
// a video segment, a DICOM pixel block; otherwise a fixed 4 MiB range.
import {U,b32,net,pool} from "./emem.mjs";
const blake3=globalThis.ememCrypto.blake3;
const H=u=>b32(blake3(u)); // full 256-bit hash for data integrity; names stay 128-bit, chunk hashes do not truncate

// ---------- bytes from the source, never more than asked ----------
const range=async(url,from,len)=>{
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

// ---------- TIFF and cloud-optimised GeoTIFF: tiles at every level ----------
const tiff=async(url,tick)=>{
 let head=await range(url,0,65536);
 const dv0=new DataView(head.buffer),le=dv0.getUint16(0)===0x4949;if(dv0.getUint16(2,le)!==42)throw new Error("Only classic TIFF is read in place (BigTIFF is not yet).");
 const at=async(o,n)=>{if(o+n>head.length){const more=await range(url,o,n);return new DataView(more.buffer)}return new DataView(head.buffer,o,n)};
 const SIZE={1:1,2:1,3:2,4:4,5:8,6:1,7:1,8:2,9:4,10:8,11:4,12:8,16:8};
 const levels=[];let ifd=dv0.getUint32(4,le),geo=null,scale=null;
 while(ifd&&levels.length<16){
  const d=await at(ifd,2),n=d.getUint16(0,le),e=await at(ifd+2,n*12+4),tags={};
  for(let i=0;i<n;i++){const t=e.getUint16(i*12,le),ty=e.getUint16(i*12+2,le),cnt=e.getUint32(i*12+4,le),sz=(SIZE[ty]||1)*cnt;
   const read=async()=>{const v=sz<=4?new DataView(e.buffer,e.byteOffset+i*12+8,4):await at(e.getUint32(i*12+8,le),sz),o=[];
    for(let k=0;k<cnt;k++)o.push(ty===3?v.getUint16(k*2,le):ty===4?v.getUint32(k*4,le):ty===12?v.getFloat64(k*8,le):ty===16?Number(v.getBigUint64(k*8,le)):v.getUint8(k));return o};
   if([256,257,258,259,277,322,323,324,325,339,33550,34735].includes(t))tags[t]=await read()}
  if(!tags[324])throw new Error("This TIFF is striped, not tiled; it is read as a plain file instead.");
  levels.push({w:tags[256][0],h:tags[257][0],tw:tags[322][0],th:tags[323][0],off:tags[324],len:tags[325],bits:tags[258]?.[0],fmt:tags[339]?.[0]||1,comp:tags[259]?.[0]});
  if(tags[34735])geo=tags[34735];if(tags[33550])scale=tags[33550];
  ifd=(await at(ifd+2+n*12,4)).getUint32(0,le);tick(`level ${levels.length}`);
 }
 let epsg=null;if(geo)for(let i=4;i+3<geo.length;i+=4)if(geo[i]===3072||geo[i]===2048)epsg=geo[i+3];
 const firstTile=Math.min(...levels.flatMap(l=>l.off.filter(o=>o>0)));
 const chunks=[{label:"header and tile tables",offset:0,length:Math.min(firstTile,65536)}];
 levels.forEach((l,li)=>{const across=Math.ceil(l.w/l.tw),picks=l.off.length<=64?[...l.off.keys()]:spread(l.off.length,li===0?6:16);
  for(const k of picks)if(l.len[k])chunks.push({label:`level ${li} tile ${k%across},${Math.floor(k/across)}`,offset:l.off[k],length:l.len[k]})});
 const L0=levels[0],total=levels.reduce((n,l)=>n+l.off.length,0);
 return{kind:"cloud-optimised GeoTIFF",chunks,units:total,
  about:[`${L0.w}×${L0.h} px, ${L0.bits}-bit ${L0.fmt===3?"float":L0.fmt===2?"signed":"unsigned"}, tiles of ${L0.tw}×${L0.th}`,
   `${levels.length} levels (${levels.map(l=>l.w).join(", ")} px wide), ${total} tiles in all`,epsg?`EPSG:${epsg}`:"",scale?`${scale[0]} ${epsg>=32601&&epsg<=32760||epsg===3857?"m":"map units"} per pixel`:""].filter(Boolean)};
};

// ---------- OME-Zarr: every level, its chunk grid, and the chunks themselves ----------
const zarr=async(url,tick)=>{
 const base=url.replace(/\/(\.zattrs|\.zgroup)?$/,"")+"/",zattrs=JSON.parse(new TextDecoder().decode(await whole(base+".zattrs")));
 const ms=zattrs.multiscales?.[0];if(!ms)throw new Error("No multiscales in .zattrs; this is not an OME-Zarr image.");
 const chunks=[{label:".zattrs",url:base+".zattrs",offset:0,length:0}],about=[];let units=0;
 const levels=[];
 for(const d of ms.datasets){const za=JSON.parse(new TextDecoder().decode(await whole(base+d.path+"/.zarray")));levels.push({path:d.path,za});chunks.push({label:`${d.path}/.zarray`,url:base+d.path+"/.zarray",offset:0,length:0})}
 levels.forEach((l,li)=>{const grid=l.za.shape.map((s,i)=>Math.ceil(s/l.za.chunks[i])),n=grid.reduce((a,b)=>a*b,1),sep=l.za.dimension_separator||".";units+=n;
  const picks=li===levels.length-1&&n<=128?[...Array(n).keys()]:spread(n,li===0?8:24);
  for(const k of picks){let r=k;const idx=grid.map(()=>0);for(let i=grid.length-1;i>=0;i--){idx[i]=r%grid[i];r=Math.floor(r/grid[i])}
   chunks.push({label:`level ${l.path} chunk ${idx.join(",")}`,url:base+l.path+"/"+idx.join(sep),offset:0,length:0})}});
 const z0=levels[0].za,axes=(ms.axes||[]).map(a=>a.name||a);
 about.push(`${z0.shape.join("×")} (${axes.join(", ")||"axes unnamed"}), ${z0.dtype}, ${z0.compressor?.cname||z0.compressor?.id||"raw"} chunks of ${z0.chunks.join("×")}`,`${levels.length} levels, ${units} chunks in all`);
 const unit=(ms.axes||[]).find(a=>a.unit)?.unit;if(unit)about.push(`space in ${unit}`);
 return{kind:"OME-Zarr image",chunks,units,about,whole:true};
};

// ---------- HLS video: segments in order, chained like a log, so a live feed extends and never rewrites ----------
const hls=async(url,tick)=>{
 let text=new TextDecoder().decode(await whole(url)),media=url;
 if(/#EXT-X-STREAM-INF/.test(text)){ // a master playlist: take the lightest variant
  const vs=[...text.matchAll(/#EXT-X-STREAM-INF:[^\n]*BANDWIDTH=(\d+)[^\n]*\n([^\n#][^\n]*)/g)].map(m=>({bw:+m[1],u:new URL(m[2].trim(),url).href})).sort((a,b)=>a.bw-b.bw);
  media=vs[0].u;text=new TextDecoder().decode(await whole(media));
 }
 const segs=[...text.matchAll(/#EXTINF:([\d.]+)[^\n]*\n([^\n#][^\n]*)/g)].map(m=>({dur:+m[1],u:new URL(m[2].trim(),media).href}));
 const live=!/#EXT-X-ENDLIST/.test(text),take=segs.slice(0,120);
 return{kind:live?"live HLS feed":"HLS video",chunks:[{label:"playlist",url:media,offset:0,length:0},...take.map((s,i)=>({label:`segment ${i} · ${s.dur}s`,url:s.u,offset:0,length:0}))],units:segs.length+1,whole:true,chained:true,
  about:[`${segs.length} segments, ${Math.round(segs.reduce((a,s)=>a+s.dur,0))} s`,live?"live: running this again extends the chain; earlier links never change":"on demand (the playlist is closed)",take.length<segs.length?`first ${take.length} segments hashed`:"every segment hashed"]};
};

// ---------- DICOM: technical tags only; nothing that identifies a person is ever copied ----------
const TAGS={"00080060":"modality","00080070":"manufacturer","00280010":"rows","00280011":"columns","00280100":"bits allocated","00280030":"pixel spacing","00180050":"slice thickness","00020010":"transfer syntax"};
const dicom=async(url,tick)=>{
 const b=await whole(url);if(new TextDecoder().decode(b.slice(128,132))!=="DICM")throw new Error("Not a DICOM file (no DICM marker).");
 const dv=new DataView(b.buffer),found={};let o=132,pixel=null,explicit=true;
 const long=new Set(["OB","OW","OF","SQ","UT","UN","OD","OL","UC","UR"]);
 while(o+8<=b.length){
  const g=dv.getUint16(o,true),e=dv.getUint16(o+2,true),tag=g.toString(16).padStart(4,"0")+e.toString(16).padStart(4,"0");
  const ex=g===2||explicit;let vr="",len,start;
  if(ex){vr=String.fromCharCode(b[o+4],b[o+5]);if(long.has(vr)){len=dv.getUint32(o+8,true);start=o+12}else{len=dv.getUint16(o+6,true);start=o+8}}
  else{len=dv.getUint32(o+4,true);start=o+8}
  if(tag==="7fe00010"){pixel={offset:start,length:len===0xffffffff?b.length-start:len};break}
  if(len===0xffffffff)throw new Error("This DICOM uses nested sequences of undefined length; it is read as a plain file instead.");
  if(TAGS[tag]&&g!==0x0010){const v=new TextDecoder().decode(b.slice(start,start+len)).replace(/\0/g,"").trim();found[TAGS[tag]]=vr==="US"||(!ex&&/^0028001[01]|00280100/.test(tag))?String(dv.getUint16(start,true)):v}
  if(tag==="00020010")explicit=!/^1\.2\.840\.10008\.1\.2\0?$/.test(found["transfer syntax"]||"");
  o=start+len;
 }
 if(!pixel)throw new Error("No pixel data found.");
 const chunks=[{label:"header (technical and identifying tags stay at the source)",offset:0,length:pixel.offset}];
 for(let p=0;p<pixel.length;p+=1<<20)chunks.push({label:`pixel data ${chunks.length}`,offset:pixel.offset+p,length:Math.min(1<<20,pixel.length-p)});
 return{kind:"DICOM image",chunks,units:chunks.length,bytes:b,
  about:[[found.modality,found.manufacturer].filter(Boolean).join(" · ")||"DICOM",found.rows&&found.columns?`${found.columns}×${found.rows} px, ${found["bits allocated"]||"?"}-bit`:"",found["pixel spacing"]?`pixel spacing ${found["pixel spacing"].split("\\").map(v=>+(+v).toFixed(3)).join(" × ")} mm`:"",found["slice thickness"]?`slice ${+(+found["slice thickness"]).toFixed(3)} mm`:""].filter(Boolean)};
};

// ---------- model weights (safetensors): every tensor is a chunk, found by the file's own header ----------
const safetensors=async(url,tick)=>{
 const n=Number(new DataView((await range(url,0,8)).buffer).getBigUint64(0,true));if(n>50e6)throw new Error("safetensors header is implausibly large.");
 const head=await range(url,8,n),meta=JSON.parse(new TextDecoder().decode(head)),base=8+n;
 const ts=Object.entries(meta).filter(([k])=>k!=="__metadata__").map(([k,v])=>({k,dtype:v.dtype,shape:v.shape,o:base+v.data_offsets[0],len:v.data_offsets[1]-v.data_offsets[0]})).sort((a,b)=>a.o-b.o);
 const params=ts.reduce((a,t)=>a+t.shape.reduce((x,y)=>x*y,1),0),dtypes=[...new Set(ts.map(t=>t.dtype))];
 // small tensors (norms, biases) are all hashed; large ones are sampled evenly; the header pins the whole layout either way
 const small=ts.filter(t=>t.len<=65536),big=ts.filter(t=>t.len>65536),picks=[...small,...spread(big.length,8).map(i=>big[i])].sort((a,b)=>a.o-b.o);
 return{kind:"model weights (safetensors)",units:ts.length+1,
  chunks:[{label:"header: every tensor's name, dtype, shape and byte range",offset:0,length:base},...picks.map(t=>({label:`tensor ${t.k} ${t.dtype}[${t.shape.join(",")}]`,offset:t.o,length:t.len}))],
  about:[`${ts.length} tensors, ${params.toLocaleString("en")} parameters, ${dtypes.join(", ")}`,`all ${small.length} small tensors and ${Math.min(8,big.length)} of ${big.length} large ones hashed; the header pins the layout of all of them`,meta.__metadata__?`metadata: ${JSON.stringify(meta.__metadata__).slice(0,120)}`:""].filter(Boolean)};
};

// ---------- a source that hides its size: stream it once, hashing 4 MiB at a time as it passes; none of it is kept ----------
const stream=async(url,tick)=>{
 const x=await net(url);if(!x.ok)throw new Error(`${url} answered ${x.status}.`);
 const rd=x.body.getReader(),C=4<<20,chunks=[];let buf=new Uint8Array(0),off=0;
 const flush=part=>{chunks.push({label:`bytes ${off}…`,offset:off,length:part.length,hash:H(part)});off+=part.length};
 for(;;){const{done,value}=await rd.read();if(value){buf=cat(buf,value);while(buf.length>=C){flush(buf.slice(0,C));buf=buf.slice(C)}tick(`${(off/1e6).toFixed(0)} MB hashed`)}if(off>1e9){rd.cancel();throw new Error("Over 1 GB with no size or byte ranges; this source cannot be pointed at from a browser.")}if(done)break}
 if(buf.length)flush(buf);
 return{kind:"file",chunks,units:chunks.length,bytes:off,streamed:true,about:[`${chunks.length} ranges of 4 MiB, read once as a stream`,"every range hashed"]};
};

// ---------- anything else: fixed ranges ----------
const file=async(url,tick,n)=>{
 const C=4<<20,count=Math.ceil(n/C),picks=n<=256e6?[...Array(count).keys()]:spread(count,32);
 return{kind:"file",chunks:picks.map(k=>({label:`bytes ${k*C}…`,offset:k*C,length:Math.min(C,n-k*C)})),units:count,about:[`${count} ranges of 4 MiB`,picks.length<count?`${picks.length} spread across the file hashed`:"every range hashed"]};
};

const pick=u=>/\.safetensors(\?|$)/i.test(u)?safetensors:/\.m3u8(\?|$)/i.test(u)?hls:/\.zarr(\/|$)/i.test(u)?zarr:/\.dcm(\?|$)/i.test(u)?dicom:/\.tiff?(\?|$)/i.test(u)?tiff:null;
export const POINTABLE=/^(point:\s*)?https?:\/\/\S+?(\.m3u8|\.zarr\/?|\.dcm|\.safetensors|\.tiff?|\.nc|\.h5|\.hdf5|\.las|\.laz|\.parquet|\.mp4|\.mov|\.bin|\.zip)(\?\S*)?$|^point:\s*https?:\/\/\S+$/i;

// read the structure, hash the chosen chunks from the source, and write the pointer's text
export const probe=async(raw,tick)=>{
 const url=raw.replace(/^point:\s*/i,"").trim(),host=new URL(url).host;
 tick("reading structure");
 const {bytes,etag}=await size(url).catch(()=>({}));
 let s;try{s=await(pick(url)||(()=>{throw new Error("plain")}))(url,tick)}catch(e){if(e.message!=="plain"&&!/read as a plain file/.test(e.message))throw e;s=bytes?await file(url,tick,bytes):await stream(url,tick)}
 let done=0,read=0;
 await pool(s.chunks,6,async c=>{
  if(c.hash){done++;read+=c.length;return}
  const b=s.bytes&&!c.url?s.bytes.slice(c.offset,c.offset+c.length):c.url?await whole(c.url).catch(e=>e.status===404?null:Promise.reject(e)):await range(url,c.offset,c.length);
  if(b===null){c.absent=true;c.hash=b32(new Uint8Array(32));c.length=0}else{c.hash=H(b);if(c.url)c.length=b.length;read+=b.length}
  tick(`${++done}/${s.chunks.length} chunks · ${mb(read)} read`);
 });
 for(const c of s.chunks)if(c.url===url)c.url="";
 let total=s.streamed?s.bytes:s.whole?null:bytes,est=null;
 if(s.whole){const got=s.chunks.filter(c=>!c.absent&&/chunk|segment/.test(c.label));if(got.length)est=Math.round(got.reduce((a,c)=>a+c.length,0)/got.length*s.units)}   // a row at the source itself is written "·" and hashed with an empty url
 const r=s.chained?chain(s.chunks):root(s.chunks),name=decodeURIComponent(url.split("/").filter(Boolean).pop()||host);
 const rows=s.chunks.map(c=>`| ${c.label} | ${c.url&&c.url!==url?c.url:"·"} | ${c.offset} | ${c.length} | ${c.absent?"absent (fill value)":c.hash} |`);
 const body=`---\nemem: pointer.v1\nsource: ${url}\nbytes: ${total??(est?`about ${est} (estimated from the chunks read)`:"unknown")}\netag: ${etag||"not exposed"}\nkind: ${s.kind}\nchunks: ${s.chunks.length} of ${s.units} hashed\n${s.chained?"chain":"root"}: ${r}\nhash: blake3-256 of each chunk's bytes\n---\n\n# ${name}\n\n> ${s.kind} at ${host}${total?`, ${mb(total)}`:est?`, about ${mb(est)}`:""}. The data stays there; this note is its address and its proofs. Read any chunk from the source by URL and byte range, then check its BLAKE3 hash below. ${s.chained?"Each link of the chain hashes the previous link with the next segment.":"The root is a Merkle tree over (url, offset, length, hash) of every row, in order."}\n\n${s.about.map(a=>"- "+a).join("\n")}\n\n## Chunks\n\n| what | url (· is the source) | offset | length | blake3 |\n|---|---|---|---|---|\n${rows.join("\n")}\n`;
 return{body,url,name,kind:s.kind,bytes:total,est,read,chunks:s.chunks,rootHash:r,chained:!!s.chained,about:s.about};
};

// re-read a spread of chunks from the source and compare: is the data still what the pointer says?
export const recheck=async(body,tick,k=6)=>{
 const src=(body.match(/^source: (\S+)/m)||[])[1],want=(body.match(/^(root|chain): (\S+)/m)||[]);
 const chunks=[...body.matchAll(/^\| ([^|]+) \| (\S+) \| (\d+) \| (\d+) \| ([a-z2-7]{52}) \|$/gm)].map(m=>({label:m[1],url:m[2]==="·"?"":m[2],offset:+m[3],length:+m[4],hash:m[5]}));
 const all=[...body.matchAll(/^\| ([^|]+) \| (\S+) \| (\d+) \| (\d+) \| ([^|]+) \|$/gm)].filter(m=>m[1]!=="what").map(m=>({url:m[2]==="·"?"":m[2],offset:+m[3],length:+m[4],hash:/^[a-z2-7]{52}$/.test(m[5].trim())?m[5].trim():b32(new Uint8Array(32))}));
 const table=want[1]==="chain"?chain(all)===want[2]:root(all)===want[2];
 let ok=0,n=0;
 for(const i of spread(chunks.length,k)){const c=chunks[i];const b=c.url?await whole(c.url):await range(src,c.offset,c.length);n++;if(H(b)===c.hash)ok++;tick(`${n}/${Math.min(k,chunks.length)} from the source`)}
 return{src,table,ok,n};
};
