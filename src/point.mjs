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
 // the answer must be the bytes asked for: same start (when the server exposes Content-Range), never longer than asked
 const cr=(x.headers.get("content-range")||"").match(/bytes (\d+)-(\d+)\/(\d+|\*)/);
 if(x.status===206&&cr&&+cr[1]!==from)throw new Error(`${new URL(url).host} answered bytes from ${cr[1]}, not ${from}.`);
 // read no further than needed: a server that ignores the range is cut off once it has sent from+len bytes
 const want=x.status===200?from+len:len,rd=x.body?.getReader();let b;
 if(rd){const parts=[];let got=0;while(got<want){const{done,value}=await rd.read();if(done)break;parts.push(value);got+=value.length}
  if(got>=want)rd.cancel().catch(()=>{});b=new Uint8Array(got);let o=0;for(const p of parts){b.set(p,o);o+=p.length}}
 else b=new Uint8Array(await x.arrayBuffer());
 if(x.status===206&&b.length>len)throw new Error(`${new URL(url).host} sent ${b.length} bytes for a ${len}-byte range.`);
 return x.status===200?b.slice(from,from+len):b;
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
// TIFF LZW: MSB-first codes of 9 to 12 bits, 256 clears, 257 ends, the width grows one code early
const lzw=src=>{const out=[];let dict=[],bits=9,pos=0,prev=null;const reset=()=>{dict=[];for(let i=0;i<256;i++)dict[i]=[i];dict[256]=dict[257]=null;bits=9};reset();
 const code=()=>{let v=0;for(let i=0;i<bits;i++){const byte=src[(pos+i)>>3];if(byte===undefined)return 257;v=(v<<1)|((byte>>(7-((pos+i)&7)))&1)}pos+=bits;return v};
 for(;;){const c=code();if(c===257)break;if(c===256){reset();prev=null;continue}
  let e=c<dict.length&&dict[c]?dict[c]:prev?[...prev,prev[0]]:null;if(!e)break;for(const x of e)out.push(x);
  if(prev){dict.push([...prev,e[0]]);if(dict.length+1>=(1<<bits)&&bits<12)bits++}prev=e}
 return new Uint8Array(out)};
const tileDecode=l=>(l.comp===8||l.comp===32946||l.comp===1||l.comp===5)&&l.bits<=32&&globalThis.DecompressionStream?async b=>{
 const raw=l.comp===1?b:l.comp===5?lzw(b):await inflate(b),dv=new DataView(raw.buffer,raw.byteOffset,raw.byteLength),n=raw.length/(l.bits/8)|0,le=l.le,v=new Float64Array(n);
 for(let i=0;i<n;i++)v[i]=l.fmt===3?(l.bits===64?dv.getFloat64(i*8,le):dv.getFloat32(i*4,le)):l.bits===8?raw[i]:l.bits===16?(l.fmt===2?dv.getInt16(i*2,le):dv.getUint16(i*2,le)):(l.fmt===2?dv.getInt32(i*4,le):dv.getUint32(i*4,le));
 if(l.pred===2){const w=l.tw*(l.spp||1),m=2**l.bits;for(let r=0;r*w<n;r++)for(let i=r*w+(l.spp||1);i<Math.min((r+1)*w,n);i++){v[i]=v[i]+v[i-(l.spp||1)];if(l.fmt!==3)v[i]=l.fmt===2?((v[i]+m/2)%m+m)%m-m/2:(v[i]%m+m)%m}}
 return v}:null;
// a JPEG-compressed tile is completed with the file's shared tables and decoded by the browser itself
const jpegTile=l=>l.comp===7&&typeof createImageBitmap!=="undefined"?async b=>{const t=l.jpt,full=t?cat(t.slice(0,-2),b.slice(2)):b;return createImageBitmap(new Blob([full],{type:"image/jpeg"}))}:null;
const tileStats=l=>{const d=tileDecode(l);if(!d)return null;
 // colour: the mean of each channel, so a tile reads as the colour it is
 if(l.spp>=3)return async b=>{const v=await d(b),m=[0,0,0];let n=0;for(let i=0;i+2<v.length;i+=l.spp){if(!v[i]&&!v[i+1]&&!v[i+2])continue;m[0]+=v[i];m[1]+=v[i+1];m[2]+=v[i+2];n++}
  return n?`mean RGB ${m.map(x=>Math.round(x/n)).join(", ")} · ${Math.round(100*n/(v.length/l.spp))}% valid`:"no valid pixels"};
 return async b=>moments(await d(b),l.nodata)};

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
   if([254,256,257,258,259,262,273,277,278,279,317,322,323,324,325,339,347,33550,33922,34735,42113].includes(t))tags[t]=await read()}
  const nextIfd=async()=>off(await at(ifd+CS+n*ES,OS),0);
  if((tags[254]?.[0]||0)&4){ifd=await nextIfd();continue} // a transparency mask, not a level
  const common={bits:tags[258]?.[0]||8,fmt:tags[339]?.[0]||1,comp:tags[259]?.[0]||1,pred:tags[317]?.[0]||1,spp:tags[277]?.[0]||1,photo:tags[262]?.[0],jpt:tags[347]?new Uint8Array(tags[347]):null,le};
  // a striped image (one strip = a few full rows) is read strip by strip; only the full-resolution level exists
  if(!tags[324]){if(!tags[273]||levels.length)throw new Error("This TIFF is striped, not tiled; it is read as a plain file instead.");
   levels.push({...common,w:tags[256][0],h:tags[257][0],tw:tags[256][0],th:tags[278]?.[0]||tags[257][0],off:tags[273],len:tags[279],strips:true});break}
  levels.push({...common,w:tags[256][0],h:tags[257][0],tw:tags[322][0],th:tags[323][0],off:tags[324],len:tags[325]});
  if(tags[34735])geo=tags[34735];if(tags[33550])scale=tags[33550];if(tags[33922])tie=tags[33922];if(tags[42113]&&tags[42113][0]!=="")nodata=+tags[42113][0];
  ifd=await nextIfd();tick(`level ${levels.length}`);
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
  // the smallest level is read whole and decoded, so the pointer can show the picture it names
  if(l.strips){const sd=tileDecode(l),picks=new Set(spread(l.off.length,96));
   l.off.forEach((o,k)=>{if(l.len[k])all.push({label:`strip ${k} rows ${k*l.th}…${Math.min(l.h,(k+1)*l.th)-1}`,offset:o,length:l.len[k],dflt:picks.has(k),stats,...(sd?{decode:sd,grab:{strip:k,x:0,y:k*l.th,tw:l.w,th:Math.min(l.th,l.h-k*l.th)}}:{})})});return}
  const last=li===levels.length-1&&l.off.length<=64,decode=last?(jpegTile(l)||tileDecode(l)):null;
  l.off.forEach((o,k)=>{if(l.len[k])all.push({label:`level ${li} tile ${k%across},${Math.floor(k/across)}`,offset:o,length:l.len[k],dflt:dflt.has(k)||(last&&!!decode),stats,...(decode?{decode,grab:{x:(k%across)*l.tw,y:Math.floor(k/across)*l.th,tw:l.tw,th:l.th}}:{})})})});
 const Ls=levels.at(-1);
 const COMP={1:"raw",5:"LZW",7:"JPEG",8:"deflate",32946:"deflate",50000:"zstd",34887:"LERC"};
 return{kind:big?"cloud-optimised BigTIFF":"cloud-optimised GeoTIFF",all,units:total+1,place,mosaic:{w:Ls.w,h:Ls.h,nodata,spp:Ls.spp,strips:!!Ls.strips,bits:Ls.bits},
  about:[`${L0.w}×${L0.h} px, ${L0.bits}-bit ${L0.fmt===3?"float":L0.fmt===2?"signed":"unsigned"}, ${COMP[L0.comp]||"compression "+L0.comp}${L0.pred===2?" with horizontal differencing":""} tiles of ${L0.tw}×${L0.th}`,
   Ls.strips?`${L0.off.length} strips of ${L0.th} rows (not tiled); ${Math.min(96,L0.off.length)} spread through the image are read`:`${levels.length} levels (${levels.map(l=>l.w).join(", ")} px wide), ${total} tiles in all`,epsg?`EPSG:${epsg}`:"",scale?`${scale[0]} ${epsg>=32601&&epsg<=32760||epsg===3857?"m":"map units"} per pixel`:"",nodata!=null?`nodata ${nodata}`:"",
   place?`centre ${place.lat}, ${place.lng}; bounds ${place.bbox.join(", ")} (west, south, east, north)`:""].filter(Boolean)};
};

// ---------- OME-Zarr: every level, its chunk grid, and the chunks themselves ----------
// Zarr v3: zarr.json per node; a sharded array stores many inner chunks per shard file, with an index at the shard's end
// (u64 offset, u64 length per inner chunk, then a crc32c). The index is read by a suffix range and checked, and each inner
// chunk becomes a row at (shard url, offset, length): named without reading the shard.
const CRC=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0x82F63B78^(c>>>1):c>>>1;t[n]=c>>>0}return t})();
const crc32c=b=>{let c=~0>>>0;for(const x of b)c=CRC[(c^x)&255]^(c>>>8);return(~c)>>>0};
// the last n bytes: a suffix range ("bytes=-n") is not CORS-safelisted and would need a preflight, so read the size, then an ordinary range
const suffix=async(url,n)=>{const{bytes:total}=await size(url);if(!total)throw new Error(`${new URL(url).host} doesn't expose ${url.split("/").pop()}'s size, so its shard index can't be found.`);return{b:await range(url,total-n,n),total}};
const zarr3=async(base,root,tick)=>{
 const all=[{label:"zarr.json",url:base+"zarr.json",offset:0,length:0,dflt:true}],about=[];let units=1;
 const ms=root.attributes?.ome?.multiscales?.[0],paths=ms?ms.datasets.map(d=>d.path):[""];
 const levels=[];for(const p of paths){const m=JSON.parse(new TextDecoder().decode(await whole(base+(p?p+"/":"")+"zarr.json")));levels.push({p,m});all.push({label:`${p||"."}/zarr.json`,url:base+(p?p+"/":"")+"zarr.json",offset:0,length:0,dflt:true});units++}
 for(const [li,{p,m}] of levels.entries()){const sh=m.codecs?.find(c=>c.name==="sharding_indexed"),outer=m.chunk_grid.configuration.chunk_shape,grid=m.shape.map((s,i)=>Math.ceil(s/outer[i])),nS=grid.reduce((a,b)=>a*b,1);
  const sep=m.chunk_key_encoding?.configuration?.separator||"/",key=idx=>(m.chunk_key_encoding?.name==="v2"?idx.join(sep):"c"+sep+idx.join(sep));
  const idxOf=k=>{let r=k;const idx=grid.map(()=>0);for(let i=grid.length-1;i>=0;i--){idx[i]=r%grid[i];r=Math.floor(r/grid[i])}return idx};
  if(!sh){units+=nS;for(const k of spread(nS,li===levels.length-1?Math.min(nS,64):8))all.push({label:`level ${p} chunk ${idxOf(k).join(",")}`,url:base+(p?p+"/":"")+key(idxOf(k)),offset:0,length:0,dflt:true});continue}
  const inner=sh.configuration.chunk_shape,nI=outer.reduce((a,s,i)=>a*Math.ceil(s/inner[i]),1),atEnd=(sh.configuration.index_location||"end")==="end",crc=(sh.configuration.index_codecs||[]).some(c=>c.name==="crc32c");
  units+=nS*nI;
  // the smallest level's shards and a spread of the largest level's: read their indexes, name their inner chunks
  const picks=li===levels.length-1?spread(nS,Math.min(nS,4)):li===0?spread(nS,2):[];
  for(const k of picks){const u=base+(p?p+"/":"")+key(idxOf(k)),n=nI*16+(crc?4:0);tick(`reading shard index ${key(idxOf(k))} at level ${p}`);
   const{b,total}=atEnd?await suffix(u,n):{b:await range(u,0,n),total:0};if(crc){const want=new DataView(b.buffer,b.byteOffset+n-4,4).getUint32(0,true);if(crc32c(b.subarray(0,n-4))!==want)throw new Error(`The shard index of ${u} fails its crc32c.`)}
   all.push({label:`level ${p} shard ${key(idxOf(k))} index`,url:u,offset:atEnd?total-n:0,length:n,ranged:true,dflt:true});
   const dv=new DataView(b.buffer,b.byteOffset),got=[];for(let i=0;i<nI;i++){const o=dv.getBigUint64(i*16,true),l=dv.getBigUint64(i*16+8,true);if(o!==0xFFFFFFFFFFFFFFFFn)got.push({i,o:Number(o),l:Number(l)})}
   const pick=new Set(spread(got.length,li===levels.length-1?Math.min(got.length,8):3));
   got.forEach((c,j)=>all.push({label:`level ${p} shard ${key(idxOf(k))} inner ${c.i}`,url:u,offset:c.o,length:c.l,ranged:true,dflt:pick.has(j)}))}}
 const m0=levels[0].m,sh0=m0.codecs?.find(c=>c.name==="sharding_indexed"),axes=m0.dimension_names||(ms?.axes||[]).map(a=>a.name);
 about.push(`${m0.shape.join("×")} (${(axes||[]).join(", ")||"axes unnamed"}), ${m0.data_type}, Zarr v3${sh0?`, shards of ${m0.chunk_grid.configuration.chunk_shape.join("×")} holding inner chunks of ${sh0.configuration.chunk_shape.join("×")}`:""}`,
  `${levels.length} level${levels.length>1?"s":""}, ${units.toLocaleString("en")} units; inner chunks are read by byte range inside their shard, after the shard's index passes its crc32c`);
 if(ms?.version)about.push(`OME-Zarr ${ms.version||root.attributes.ome.version}`);
 return{kind:"Zarr v3 array (sharded)",all,units,about,whole:true};
};
const zarr=async(url,tick)=>{
 const base0=url.replace(/\/(\.zattrs|\.zgroup|zarr\.json)?$/,"")+"/";
 const zj=await whole(base0+"zarr.json").catch(()=>null);if(zj)return zarr3(base0,JSON.parse(new TextDecoder().decode(zj)),tick);
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
 const live=!/#EXT-X-ENDLIST/.test(text),seq=live?+(text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)||[])[1]||0:0;
 // a live window slides: segments are named by their media sequence number, and each playlist version is its own row
 return{kind:live?"live HLS feed":"HLS video",all:[{label:live?`playlist at sequence ${seq}`:"playlist",url:media,offset:0,length:0,dflt:true},...segs.map((s,i)=>({label:`segment ${seq+i} · ${s.dur}s`,url:s.u,offset:0,length:0,dflt:i<120}))],units:segs.length+1,whole:true,chained:true,
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
 // the slice itself, in its stored unit, for the preview; its bytes are the ones just hashed
 const R=+found.rows||0,Cc=+found.columns||0;let preview=null;
 if(raw&&R&&Cc&&pixel.length>=R*Cc*2){const d=new DataView(b.buffer,b.byteOffset+pixel.offset,R*Cc*2),v=new Float64Array(R*Cc);for(let i=0;i<v.length;i++)v[i]=(signed?d.getInt16(i*2,true):d.getUint16(i*2,true))*slope+icpt;preview={kind:"grid",w:Cc,h:R,v,label:hu?"HU":""}}
 return{kind:"DICOM image",all,units:all.length,bytes:b,preview,
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

// ---------- Gaussian splats (.splat, 3DGS .ply): every block of splats is a chunk; the scene is drawn from the ones read ----------
// .splat: 32 bytes per splat (position 3×f32, scale 3×f32, colour RGBA u8, rotation 4×u8). .ply: a header naming float properties.
const splats=async(url,tick,bytes)=>{
 let stride=32,base=0,n=0,pos=[0,4,8],col=null,opa=null,fmt="splat";
 if(/\.ply(\?|$)/i.test(url)){
  const head=new TextDecoder().decode(await range(url,0,65536)),end=head.indexOf("end_header\n");if(end<0)throw new Error("No PLY header found.");
  if(!/format binary_little_endian/.test(head))throw new Error("Only binary little-endian PLY is read in place.");
  n=+(head.match(/element vertex (\d+)/)||[])[1];const props=[...head.slice(head.indexOf("element vertex")).matchAll(/property (\w+) (\w+)/g)].map(m=>({t:m[1],name:m[2]}));
  const SZ={float:4,float32:4,double:8,uchar:1,uint8:1,int:4,uint:4,short:2,ushort:2},off={};stride=0;for(const p of props){off[p.name]=stride;stride+=SZ[p.t]||4}
  base=end+11;pos=[off.x,off.y,off.z];fmt=off.f_dc_0!=null?"3DGS ply":"ply";
  if(off.f_dc_0!=null)col=(dv,o)=>[0,1,2].map(i=>Math.max(0,Math.min(255,Math.round((.5+.28209479*dv.getFloat32(o+off["f_dc_"+i],true))*255))));
  else if(off.red!=null)col=(dv,o)=>[dv.getUint8(o+off.red),dv.getUint8(o+off.green),dv.getUint8(o+off.blue)];
  if(off.opacity!=null)opa=(dv,o)=>1/(1+Math.exp(-dv.getFloat32(o+off.opacity,true)));
 }else{if(!bytes||bytes%32)throw new Error("A .splat file is a whole number of 32-byte splats; this one is not.");n=bytes/32;col=(dv,o)=>[dv.getUint8(o+24),dv.getUint8(o+25),dv.getUint8(o+26)];opa=(dv,o)=>dv.getUint8(o+27)/255}
 const per=65536,blocks=Math.ceil(n/per),xs=[],ys=[],zs=[],rgb=[];
 const stats=b=>{const dv=new DataView(b.buffer,b.byteOffset,b.byteLength),k=Math.floor(b.length/stride),lo=[1e9,1e9,1e9],hi=[-1e9,-1e9,-1e9];let a=0;
  for(let i=0;i<k;i++){const o=i*stride;for(let d=0;d<3;d++){const p=dv.getFloat32(o+pos[d],true);if(p<lo[d])lo[d]=p;if(p>hi[d])hi[d]=p}if(opa)a+=opa(dv,o)}
  return`${k} splats · x ${g4(lo[0])}…${g4(hi[0])} · y ${g4(lo[1])}…${g4(hi[1])} · z ${g4(lo[2])}…${g4(hi[2])}${opa?` · mean opacity ${g4(a/k)}`:""}`};
 const all=[{label:`header`,offset:0,length:base||0,dflt:!!base},...Array.from({length:blocks},(_,i)=>({label:`splats ${i*per}…${Math.min(n,(i+1)*per)-1}`,offset:base+i*per*stride,length:Math.min(per,n-i*per)*stride,dflt:blocks<=16||spread(blocks,16).includes(i),stats}))].filter(c=>c.length);
 return{kind:`Gaussian splats (${fmt})`,all,units:all.length,
  sample:(c,b)=>{if(!/^splats/.test(c.label))return;const dv=new DataView(b.buffer,b.byteOffset,b.byteLength),k=Math.floor(b.length/stride),step=Math.max(1,Math.floor(k/12000));
   for(let i=0;i<k;i+=step){const o=i*stride;if(opa&&opa(dv,o)<.05)continue;xs.push(dv.getFloat32(o+pos[0],true));ys.push(dv.getFloat32(o+pos[1],true));zs.push(dv.getFloat32(o+pos[2],true));rgb.push(col?col(dv,o):[200,200,200])}},
  points:()=>({xs,ys,zs,rgb}),
  about:[`${n.toLocaleString("en")} splats, ${stride} bytes each, ${fmt}`,`${blocks} blocks of ${per.toLocaleString("en")}; each hashed block carries its bounding box and mean opacity`]};
};

// ---------- video (MP4): the index at either end names every frame; a keyframe group (GOP) is a chunk ----------
// Keyframes are decoded by the browser's own video decoder (WebCodecs) from the very bytes that were hashed.
const box=(b,o)=>{const dv=new DataView(b.buffer,b.byteOffset,b.byteLength);let sz=dv.getUint32(o),h=8;const t=String.fromCharCode(b[o+4],b[o+5],b[o+6],b[o+7]);if(sz===1){sz=Number(dv.getBigUint64(o+8));h=16}else if(sz===0)sz=b.length-o;return{t,o,sz,h,end:o+sz}};
const kids=(b,o,end)=>{const out=[];while(o+8<=end){const x=box(b,o);if(x.sz<8)break;out.push(x);o=x.end}return out};
const find=(b,o,end,path)=>{let cur=[{o,end,h:0,sz:end-o}];for(const t of path){const nx=[];for(const c of cur)for(const k of kids(b,c.o+c.h,c.end))if(k.t===t)nx.push(k);cur=nx}return cur};
const hex2=n=>n.toString(16).padStart(2,"0");
const mp4=async(url,tick,bytes)=>{
 if(!bytes)throw new Error("plain");
 const tops=[];let o=0;while(o<bytes&&tops.length<32){const h=await range(url,o,16),x=box(h,0);if(x.sz<8)break;tops.push({t:x.t,o,sz:x.sz});o+=x.sz}
 const mv=tops.find(t=>t.t==="moov");if(!mv||mv.sz>64e6)throw new Error("plain");
 tick("reading the index");const m=await range(url,mv.o,mv.sz),D=new DataView(m.buffer);
 const trak=find(m,0,m.length,["moov","trak"]).find(t=>{const h=find(m,t.o+t.h,t.end,["mdia","hdlr"])[0];return h&&String.fromCharCode(...m.slice(h.o+16,h.o+20))==="vide"});
 if(!trak)throw new Error("plain");
 const q=path=>find(m,trak.o+trak.h,trak.end,path)[0],stbl=["mdia","minf","stbl"];
 const mdhd=q(["mdia","mdhd"]),v1=m[mdhd.o+8]===1,ts=D.getUint32(mdhd.o+(v1?28:20)),dur=v1?Number(D.getBigUint64(mdhd.o+32)):D.getUint32(mdhd.o+24);
 const stsd=q([...stbl,"stsd"]),entry=box(m,stsd.o+16),codec4=entry.t,W=D.getUint16(entry.o+32),Hh=D.getUint16(entry.o+34);
 const cfgBox=kids(m,entry.o+86,entry.end).find(k=>k.t==="av1C"||k.t==="avcC"||k.t==="hvcC");
 let codec=null,description=null;
 if(cfgBox){description=m.slice(cfgBox.o+8,cfgBox.end);const c=description;
  if(cfgBox.t==="av1C"){const prof=c[1]>>5,lvl=c[1]&31,tier=c[2]>>7,hi=(c[2]>>6)&1,twelve=(c[2]>>5)&1;codec=`av01.${prof}.${String(lvl).padStart(2,"0")}${tier?"H":"M"}.${hi?(twelve?"12":"10"):"08"}`}
  else if(cfgBox.t==="avcC")codec=`avc1.${hex2(c[1])}${hex2(c[2])}${hex2(c[3])}`}
 const u32s=(bx,skip)=>{const n=D.getUint32(bx.o+12),a=new Array(n);for(let i=0;i<n;i++)a[i]=D.getUint32(bx.o+16+i*skip*4);return a};
 const stsz=q([...stbl,"stsz"]),fixed=D.getUint32(stsz.o+12),ns=D.getUint32(stsz.o+16),sizes=fixed?new Array(ns).fill(fixed):Array.from({length:ns},(_,i)=>D.getUint32(stsz.o+20+i*4));
 const stco=q([...stbl,"stco"]),co64=q([...stbl,"co64"]),chunkOff=stco?u32s(stco,1):Array.from({length:D.getUint32(co64.o+12)},(_,i)=>Number(D.getBigUint64(co64.o+16+i*8)));
 const stsc=q([...stbl,"stsc"]),runs=Array.from({length:D.getUint32(stsc.o+12)},(_,i)=>[D.getUint32(stsc.o+16+i*12),D.getUint32(stsc.o+20+i*12)]);
 const off=new Array(ns);let si=0;for(let c=0;c<chunkOff.length&&si<ns;c++){let per=runs[0][1];for(const[first,n]of runs)if(c+1>=first)per=n;let p=chunkOff[c];for(let k=0;k<per&&si<ns;k++){off[si]=p;p+=sizes[si];si++}}
 const stss=q([...stbl,"stss"]),keys=stss?u32s(stss,1).map(x=>x-1):[0];
 const fps=ns/(dur/ts),all=[{label:"file header",offset:0,length:Math.min(tops[0]?.sz||0,4096),dflt:true},{label:"index (moov): every frame's size and place",offset:mv.o,length:mv.sz,dflt:true}];
 const dfl=new Set(spread(keys.length,12));
 keys.forEach((k,i)=>{const e=(keys[i+1]??ns)-1,a=off[k],z=off[e]+sizes[e];if(!(z>a))return;
  all.push({label:`frames ${k}…${e} · ${(k/fps).toFixed(1)} s`,offset:a,length:z-a,dflt:dfl.has(i),stats:()=>`${e-k+1} frames · ${Math.round((z-a)*8/((e-k+1)/fps)/1000)} kbit/s`,
   ...(codec&&typeof VideoDecoder!=="undefined"&&dfl.has(i)?{decode:async b=>frameOf({codec,description,codedWidth:W,codedHeight:Hh},b.slice(0,sizes[k]),`${(k/fps).toFixed(1)} s`),grab:{video:true,t:k/fps}}:{})})});
 return{kind:"video (MP4)",all,units:all.length,frames:true,
  about:[`${codec4}${codec?` (${codec})`:""}, ${W}×${Hh}, ${ns.toLocaleString("en")} frames at ${fps.toFixed(1)} fps, ${(dur/ts/60).toFixed(1)} min`,`${keys.length} keyframe groups; each hashed group carries its frame count and bit rate`,codec?"keyframes decoded here from the hashed bytes":""].filter(Boolean)};
};
const frameOf=(config,data,label)=>new Promise((res,rej)=>{let done=false;const d=new VideoDecoder({output:f=>{if(done){f.close();return}done=true;const cv=document.createElement("canvas");cv.className="grid";cv.width=f.displayWidth;cv.height=f.displayHeight;const g=cv.getContext("2d");g.drawImage(f,0,0);f.close();
   g.font="bold 20px ui-monospace,monospace";g.fillStyle="rgba(0,0,0,.55)";g.fillRect(6,6,92,28);g.fillStyle="#fff";g.fillText(label,12,27);cv.dataset.date=label;try{d.close()}catch{}res(cv)},error:e=>rej(e)});
 d.configure(config);d.decode(new EncodedVideoChunk({type:"key",timestamp:0,data}));d.flush().catch(rej);setTimeout(()=>{if(!done)rej(new Error("decode timed out"))},8000)});

// ---------- photographs (JPEG): the whole picture hashed; where, when and with what it was taken, from its EXIF ----------
const exif=b=>{let o=2;while(o+4<b.length&&b[o]===0xFF){const mk=b[o+1],len=(b[o+2]<<8)|b[o+3];if(mk===0xE1&&String.fromCharCode(...b.slice(o+4,o+8))==="Exif"){const t=o+10,dv=new DataView(b.buffer,b.byteOffset+t),le=dv.getUint16(0)===0x4949;
   const ifd=(p)=>{const n=dv.getUint16(p,le),o2={};for(let i=0;i<n;i++){const e=p+2+i*12,tag=dv.getUint16(e,le),ty=dv.getUint16(e+2,le),cnt=dv.getUint32(e+4,le),sz=({1:1,2:1,3:2,4:4,5:8,7:1,10:8}[ty]||1)*cnt,vo=sz<=4?e+8:dv.getUint32(e+8,le);
     const rat=k=>dv.getUint32(vo+k*8,le)/(dv.getUint32(vo+k*8+4,le)||1);o2[tag]=ty===2?new TextDecoder().decode(new Uint8Array(dv.buffer,dv.byteOffset+vo,Math.max(0,cnt-1))):ty===5?Array.from({length:cnt},(_,k)=>rat(k)):ty===3?dv.getUint16(vo,le):ty===4?dv.getUint32(vo,le):dv.getUint8(vo)}return o2};
   const i0=ifd(dv.getUint32(4,le)),ex=i0[34665]?ifd(i0[34665]):{},gp=i0[34853]?ifd(i0[34853]):{};
   const dms=a=>a?a[0]+a[1]/60+a[2]/3600:null,lat=dms(gp[2]),lng=dms(gp[4]);
   return{make:i0[271],model:i0[272],when:(ex[36867]||i0[306]||"").replace(/^(\d{4}):(\d\d):(\d\d)/,"$1-$2-$3"),lat:lat!=null?(gp[1]==="S"?-lat:lat):null,lng:lng!=null?(gp[3]==="W"?-lng:lng):null,alt:gp[6]?.[0]}}
  o+=2+len}return{}};
const photo=async(url,tick,bytes)=>{
 if(bytes&&bytes>60e6)throw new Error("plain");
 const b=await whole(url);if(b[0]!==0xFF||b[1]!==0xD8)throw new Error("plain");
 const x=exif(b),C=1<<20,all=[];for(let o=0;o<b.length;o+=C)all.push({label:o?`bytes ${o}…`:"first MiB (with EXIF)",offset:o,length:Math.min(C,b.length-o),dflt:true});
 let preview=null;if(typeof createImageBitmap!=="undefined"){try{const bm=await createImageBitmap(new Blob([b],{type:"image/jpeg"}));preview={kind:"tiles",w:bm.width,h:bm.height,tiles:[{x:0,y:0,img:bm}]}}catch{}}
 return{kind:"photograph (JPEG)",all,units:all.length,bytes:b,preview,place:x.lat!=null?{lat:+x.lat.toFixed(6),lng:+x.lng.toFixed(6),bbox:[x.lng,x.lat,x.lng,x.lat]}:null,
  about:[[x.make,x.model].filter(Boolean).join(" ")||"camera not recorded",x.when?`taken ${x.when}`:"time not recorded",x.lat!=null?`at ${x.lat.toFixed(5)}, ${x.lng.toFixed(5)}${x.alt!=null?`, ${Math.round(x.alt)} m`:""} (from its EXIF)`:"no place in its EXIF","the whole picture is hashed; the preview is drawn from those bytes"]};
};

// ---------- climate data (NetCDF-3 classic / 64-bit offset): the header lists every variable's type, shape and byte range ----------
const NCT={1:["byte",1],2:["char",1],3:["short",2],4:["int",4],5:["float",4],6:["double",8]};
const netcdf3=async(url,tick,bytes)=>{
 let buf=await range(url,0,Math.min(bytes||1<<20,1<<20));const v2=buf[3]===2||buf[3]===5,big=buf[3]===5;let p=4;
 const need=async n=>{if(p+n>buf.length){if(buf.length>=64<<20)throw new Error("NetCDF header is implausibly large.");const more=await range(url,buf.length,Math.max(n,buf.length));const b=new Uint8Array(buf.length+more.length);b.set(buf);b.set(more,buf.length);buf=b}};
 const u32=async()=>{await need(4);const v=new DataView(buf.buffer,buf.byteOffset+p,4).getUint32(0);p+=4;return v};
 const u64=async()=>{await need(8);const v=Number(new DataView(buf.buffer,buf.byteOffset+p,8).getBigUint64(0));p+=8;return v};
 const len=big?u64:u32,name=async()=>{const n=await len();await need(n);const t=new TextDecoder().decode(buf.subarray(p,p+n));p+=n+((4-n%4)%4);return t};
 const atts=async()=>{const tag=await u32(),n=await len();const out={};if(tag===0&&n===0)return out;for(let i=0;i<n;i++){const k=await name(),t=await u32(),m=await len(),[,w]=NCT[t]||["?",1],sz=m*w;await need(sz);
   const raw=buf.subarray(p,p+sz);out[k]=t===2?new TextDecoder().decode(raw).replace(/[\0\s]+$/,""):[...Array(Math.min(m,4)).keys()].map(j=>{const d=new DataView(raw.buffer,raw.byteOffset+j*w,w);return t===5?d.getFloat32(0):t===6?d.getFloat64(0):t===3?d.getInt16(0):t===4?d.getInt32(0):raw[j]}).join(",");p+=sz+((4-sz%4)%4)}return out};
 const numrecs=await len();await u32();const nd=await len(),dims=[];for(let i=0;i<nd;i++)dims.push({name:await name(),size:await len()});
 const gatt=await atts();await u32();const nv=await len(),vars=[];
 for(let i=0;i<nv;i++){const nm=await name(),nds=await len(),ids=[];for(let j=0;j<nds;j++)ids.push(await len());const va=await atts(),t=await u32(),vsize=await u32(),begin=v2?await u64():await u32();vars.push({nm,ids,va,t,vsize,begin})}
 const hdr=p,recvars=vars.filter(v=>v.ids.length&&dims[v.ids[0]].size===0),recsize=recvars.length===1?recvars[0].vsize:recvars.reduce((a,v)=>a+v.vsize,0);
 const stat=t=>b=>{const[,w]=NCT[t]||[];if(t!==5&&t!==6)return"";const dv=new DataView(b.buffer,b.byteOffset,b.length);let n=0,sum=0,lo=Infinity,hi=-Infinity;for(let o=0;o+w<=b.length;o+=w*Math.max(1,Math.floor(b.length/w/20000))){const x=t===5?dv.getFloat32(o):dv.getFloat64(o);if(!Number.isFinite(x)||Math.abs(x)>=9.9e36)continue;n++;sum+=x;lo=Math.min(lo,x);hi=Math.max(hi,x)}return n?`mean ${(sum/n).toPrecision(5)} min ${lo.toPrecision(5)} max ${hi.toPrecision(5)}`:""};
 const shape=v=>v.ids.map(i=>dims[i].size||numrecs).join(","),unit=v=>v.va.units?` (${v.va.units})`:"";
 const chunks=[];for(const v of vars){const T=(NCT[v.t]||["?"])[0];
  if(recvars.includes(v))for(let r=0;r<numrecs;r++)chunks.push({label:`variable ${v.nm} ${T}[${shape(v)}] record ${r}`,offset:v.begin+r*recsize,length:v.vsize,stats:stat(v.t),small:false});
  else chunks.push({label:`variable ${v.nm} ${T}[${shape(v)}]`,offset:v.begin,length:v.vsize,stats:stat(v.t),small:v.vsize<=65536})}
 // the defaults favour the main gridded variable (the largest per record), so the pointer samples what the file is for
 const mainV=[...vars].sort((a,b)=>b.vsize-a.vsize)[0],isMain=c=>c.label.startsWith(`variable ${mainV?.nm} `);
 const pickC=new Set([...firstBy(chunks.filter(c=>!c.small&&isMain(c)),c=>c.label,8),...firstBy(chunks.filter(c=>!c.small&&!isMain(c)),c=>c.label,2)]);
 const main=vars.filter(v=>v.ids.length>=2).map(v=>`${v.nm}${unit(v)}`).slice(0,8);
 // a preview: the main variable's first level, if its last two dimensions are lat and lon
 const md=mainV?mainV.ids.map(i=>dims[i]):[],la=md.at(-2),lo=md.at(-1),geo=la&&lo&&/lat/i.test(la.name)&&/lon/i.test(lo.name)&&(mainV.t===5||mainV.t===6);
 const field=geo?{w:lo.size,h:la.size}:null,w8=geo?NCT[mainV.t][1]:0,flip=geo;
 const dec=geo?b=>{const dv=new DataView(b.buffer,b.byteOffset,b.length),W=field.w,Hh=field.h,v=new Float64Array(W*Hh);
  for(let y=0;y<Hh;y++)for(let x=0;x<W;x++){const o=(y*W+x)*w8;if(o+w8>b.length){v[(Hh-1-y)*W+x]=NaN;continue}const q=mainV.t===5?dv.getFloat32(o):dv.getFloat64(o);v[(Hh-1-y)*W+x]=Number.isFinite(q)&&Math.abs(q)<9.9e36?q:NaN}return v}:null;
 return{kind:`climate data (NetCDF-3 ${v2?"64-bit offset":"classic"})`,units:chunks.length+1,field,
  all:[{label:"header: dimensions, attributes, every variable's type, shape and byte range",offset:0,length:hdr,dflt:true},...chunks.map(c=>({...c,dflt:c.small||pickC.has(c),...(dec&&isMain(c)&&pickC.has(c)?{decode:async b=>dec(b)}:{})}))],
  about:[`dimensions: ${dims.map(d=>`${d.name} ${d.size||`${numrecs} (records)`}`).join(", ")}`,`${vars.length} variables; gridded: ${main.join(", ")}`,gatt.title||gatt.source?String(gatt.title||gatt.source).trim().slice(0,140):"",gatt.institution?`from ${String(gatt.institution).trim().slice(0,100)}`:"",gatt.experiment_id?`experiment ${gatt.experiment_id}${gatt.variant_label?`, ${gatt.variant_label}`:""}`:"","float variables carry mean, min and max over the bytes read (fill values skipped)"].filter(Boolean)};
};

// ---------- HDF5 / NetCDF-4: rows are 4 MiB ranges (full coverage, never overlapping); the variables are read from the file's
// own structure and listed: superblock → root group (symbol table, compact links, or dense links in a fractal heap) → each
// dataset's object header (v1 or v2) → its dataspace, datatype, filters and layout.
const hdf5=async(url,tick,bytes)=>{
 let at=-1,sb=null;for(const o of[0,512,1024,2048]){sb=await range(url,o,160);if(sb[0]===0x89&&String.fromCharCode(...sb.slice(1,4))==="HDF"){at=o;break}}
 if(at<0)throw new Error("Not an HDF5 file (no signature).");const ver=sb[8];
 const s=await file(url,tick,bytes);const keep=new Set(spread(s.all.length,8));s.all=s.all.map((c,i)=>({...c,dflt:keep.has(i)}));s.kind=`HDF5 / NetCDF-4 (superblock v${ver})`;
 s.all[0]={...s.all[0],label:`superblock and first bytes (${s.all[0].label})`};
 let cat="";try{cat=await h5catalog(url,at,sb,bytes,tick)}catch(e){cat=`its variables couldn't be listed (${e.message})`}
 s.about=[`HDF5 superblock v${ver} at byte ${at}; rows are ${s.units} ranges of 4 MiB covering every byte`,cat].filter(Boolean);return s};
const h5catalog=async(url,at,sb,bytes,tick)=>{
 const pages=new Map(),P=65536;let reads=0;
 const pageOf=n=>{if(!pages.has(n)){if(++reads>400)throw new Error("metadata is spread over too many pages");pages.set(n,range(url,at+n*P,Math.min(P,Math.max(1,(bytes||Infinity)-at-n*P))))}return pages.get(n)};
 const rd=async(a,n)=>{const out=new Uint8Array(n);let o=0;while(o<n){const p=Math.floor((a+o)/P),pg=await pageOf(p),off=(a+o)%P,k=Math.min(n-o,pg.length-off);if(k<=0)throw new Error("read past the end");out.set(pg.subarray(off,off+k),o);o+=k}return new DataView(out.buffer)};
 const u=(dv,o,n)=>n===8?Number(dv.getBigUint64(o,true)):n===4?dv.getUint32(o,true):n===2?dv.getUint16(o,true):dv.getUint8(o);
 const sig=(dv,o=0)=>String.fromCharCode(dv.getUint8(o),dv.getUint8(o+1),dv.getUint8(o+2),dv.getUint8(o+3));
 const ver=sb[8],sd=new DataView(sb.buffer,sb.byteOffset),os=ver<2?sb[13]:sb[9];if(os!==8)throw new Error(`${os}-byte addresses`);
 // object header messages, v1 or v2, following continuation blocks
 const messages=async a=>{const h=await rd(a,32),out=[],blocks=[];let v2=false,ocrd=false;
  if(sig(h)==="OHDR"){v2=true;const fl=h.getUint8(5);let o=6;if(fl&0x20)o+=16;if(fl&0x10)o+=4;const cs=[1,2,4,8][fl&3];blocks.push([a+o+cs,u(h,o,cs)]);ocrd=!!(fl&4)}
  else if(h.getUint8(0)===1)blocks.push([a+16,h.getUint32(8,true)]);else throw new Error("unknown object header");
  let guard=0;while(blocks.length&&guard++<32){const[b0,len]=blocks.shift(),b=await rd(b0,len);let o=0;
   while(o+(v2?4:8)<=len-(v2?4:0)){let t,sz;if(v2){t=b.getUint8(o);sz=b.getUint16(o+1,true);o+=4+(ocrd?2:0)}else{t=b.getUint16(o,true);sz=b.getUint16(o+2,true);o+=8}
    if(o+sz>len)break;const dv=new DataView(b.buffer,b.byteOffset+o,sz);out.push({t,dv});if(t===0x10){const ca=u(dv,0,8),cl=u(dv,8,8);blocks.push(v2?[ca+4,cl-4]:[ca,cl])}o+=sz}}
  return out};
 // a link message (compact group, or an object in a dense group's fractal heap): name → object header address
 const link=(dv,o)=>{if(dv.getUint8(o)!==1)return null;const f=dv.getUint8(o+1);let p=o+2,type=0;if(f&8)type=dv.getUint8(p++);if(f&4)p+=8;if(f&0x10)p++;
  const ns=1<<(f&3),nl=u(dv,p,ns);p+=ns;const name=new TextDecoder().decode(new Uint8Array(dv.buffer,dv.byteOffset+p,nl));p+=nl;if(type!==0)return{name,end:p+2+u(dv,p,2)};return{name,oh:u(dv,p,8),end:p+8}};
 let links=[];
 const root=ver<2?u(sd,(ver===1?60:56)+8,8):u(sd,12+8*3,8),rm=await messages(root);
 const stab=rm.find(m=>m.t===0x11),linfo=rm.find(m=>m.t===0x2);
 for(const m of rm.filter(m=>m.t===0x6)){const l=link(m.dv,0);if(l?.oh!=null)links.push(l)}
 if(stab){ // old-style group: B-tree of symbol table nodes, names in a local heap
  const bt=u(stab.dv,0,8),hp=await rd(u(stab.dv,8,8),32),names=new Uint8Array((await rd(u(hp,24,8),Math.min(u(hp,8,8),1<<20))).buffer),nameAt=o=>{let e=o;while(e<names.length&&names[e])e++;return new TextDecoder().decode(names.subarray(o,e))};
  const walk=async a=>{const n=await rd(a,24);if(sig(n)!=="TREE")throw new Error("bad group B-tree");const lvl=n.getUint8(5),k=n.getUint16(6,true),body=await rd(a+24,(k*2+1)*8);
   for(let i=0;i<k;i++){const c=u(body,8+i*16,8);if(lvl>0)await walk(c);else{const sn=await rd(c,8),cnt=sn.getUint16(6,true),es=await rd(c+8,cnt*40);for(let j=0;j<cnt;j++)links.push({name:nameAt(u(es,j*40,8)),oh:u(es,j*40+8,8)})}}};
  await walk(bt)}
 if(linfo){ // dense group: link messages are objects in a fractal heap; its direct blocks are read in order
  const fl=linfo.dv.getUint8(1),fh=u(linfo.dv,2+(fl&1?8:0),8),H=await rd(fh,160);if(sig(H)!=="FRHP")throw new Error("no fractal heap");
  const filt=H.getUint16(7,true),hflags=H.getUint8(9);let o=10+4+8+8+8+8+8+8+8+8+8+8+8+8;const width=H.getUint16(o,true),start=u(H,o+2,8),maxDirect=u(H,o+10,8),maxHeap=H.getUint16(o+18,true);o+=18+2+2;
  const rootAddr=u(H,o,8),rows=H.getUint16(o+8,true);if(filt)throw new Error("the link heap is filtered");
  const offBytes=Math.ceil(maxHeap/8),direct=async(a,size)=>{const d=await rd(a,size);if(sig(d)!=="FHDB")return;let p=5+8+offBytes+(hflags&2?4:0);while(p<size-4){const l=link(d,p);if(!l)break;if(l.oh!=null)links.push(l);p=l.end}};
  if(rows===0)await direct(rootAddr,start);
  else{const ib=await rd(rootAddr,5+8+offBytes+rows*width*8),n=Math.min(rows*width,256);let base=5+8+offBytes;
   for(let k=0;k<n;k++){const a=u(ib,base+k*8,8),r=Math.floor(k/width),size=start*2**Math.max(0,r-1);if(a&&a!==0xFFFFFFFFFFFFFFFF&&size<=maxDirect)await direct(a,size)}}}
 if(!links.length)throw new Error("no links found in the root group");
 // each dataset: shape, type, filters, layout
 const TYPES={0:"int",1:"float",3:"string",6:"compound",9:"vlen"},vars=[];tick(`reading ${links.length} object headers`);
 for(const l of links.slice(0,300)){let ms;try{ms=await messages(l.oh)}catch{continue}
  const sp=ms.find(m=>m.t===1),dt=ms.find(m=>m.t===3),ly=ms.find(m=>m.t===8),fp=ms.find(m=>m.t===0xB);if(!sp||!ly)continue;
  const sv=sp.dv.getUint8(0),rank=sp.dv.getUint8(1),dims=[...Array(rank).keys()].map(i=>u(sp.dv,(sv===1?8:4)+i*8,8));
  const cls=dt?dt.dv.getUint8(0)&15:-1,esz=dt?dt.dv.getUint32(4,true):0,lc=ly.dv.getUint8(1);
  vars.push({name:l.name,desc:`${l.name} ${TYPES[cls]||"type"+cls}${esz*8}[${dims.join(",")}] ${["compact","contiguous","chunked","virtual"][lc]||"?"}${fp?`, ${fp.dv.getUint8(1)} filter${fp.dv.getUint8(1)===1?"":"s"}`:""}`,n:dims.reduce((a,b)=>a*b,1)*esz})}
 vars.sort((a,b)=>b.n-a.n);
 return`${vars.length} variables, read from the file's own headers (${reads} metadata pages): ${vars.slice(0,24).map(v=>v.desc).join("; ")}${vars.length>24?` … and ${vars.length-24} more`:""}`;
};

// ---------- lidar (COPC: cloud-optimized LAZ): a LAS 1.4 header, a copc info record, then an octree whose nodes are chunks ----------
const copc=async(url,tick)=>{
 const h=await range(url,0,589);if(String.fromCharCode(...h.slice(0,4))!=="LASF")throw new Error("Not a LAS/LAZ file.");
 const dv=new DataView(h.buffer,h.byteOffset),hs=dv.getUint16(94,true),toPts=dv.getUint32(96,true),fmt=h[104]&0x3f,n=Number(dv.getBigUint64(247,true))||dv.getUint32(107,true);
 const uid=new TextDecoder().decode(h.slice(hs+2,hs+18)).replace(/\0/g,"");if(uid!=="copc")throw new Error("A LAS/LAZ file, but not COPC (no copc info record first).");
 const ci=hs+54,g=o=>dv.getFloat64(ci+o,true),rootOff=Number(dv.getBigUint64(ci+40,true)),rootLen=Number(dv.getBigUint64(ci+48,true));
 const bb=[dv.getFloat64(187,true),dv.getFloat64(179,true),dv.getFloat64(203,true),dv.getFloat64(195,true)]; // min x, max x ... (LAS: max x @179, min x @187, max y @195, min y @203)
 tick("reading the octree hierarchy");const page=await range(url,rootOff,rootLen),pv=new DataView(page.buffer,page.byteOffset),nodes=[];
 for(let o=0;o+32<=page.length;o+=32){const d=pv.getInt32(o,true),x=pv.getInt32(o+4,true),y=pv.getInt32(o+8,true),z=pv.getInt32(o+12,true),off=Number(pv.getBigUint64(o+16,true)),bs=pv.getInt32(o+24,true),pc=pv.getInt32(o+28,true);
  if(pc>0&&bs>0)nodes.push({label:`octree node ${d}-${x}-${y}-${z} · ${pc.toLocaleString("en")} points`,offset:off,length:bs,d,pc})}
 nodes.sort((a,b)=>a.d-b.d||a.offset-b.offset);const pick=new Set([nodes[0],...firstBy(nodes.slice(1),c=>c.label,7)]);
 return{kind:"lidar point cloud (COPC)",units:nodes.length+2,
  all:[{label:"LAS header and records (incl. copc info, CRS)",offset:0,length:toPts,dflt:true},{label:"octree hierarchy (root page)",offset:rootOff,length:rootLen,dflt:true},...nodes.map(c=>({...c,dflt:pick.has(c)}))],
  about:[`${n.toLocaleString("en")} points, LAS point format ${fmt}`,`octree: ${nodes.length} nodes in the root page, down to depth ${Math.max(...nodes.map(c=>c.d))}; each node is a LAZ-compressed chunk`,`extent x ${bb[0].toFixed(1)}…${bb[1].toFixed(1)}, y ${bb[2].toFixed(1)}…${bb[3].toFixed(1)} (in the file's CRS), spacing ${g(32).toFixed(2)}`]};
};

// a .nc is NetCDF-3 (CDF\x01/\x02/\x05) or NetCDF-4 (HDF5): the first bytes decide
const ncOrH5=async(url,tick,bytes)=>{const m=await range(url,0,4);return String.fromCharCode(m[0],m[1],m[2])==="CDF"?netcdf3(url,tick,bytes):hdf5(url,tick,bytes)};

// ---------- private buckets: a presigned URL's credential is used for this run and never stored ----------
const CRED=/^(x-amz-|x-goog-)|^(signature|expires|key-pair-id|policy|sig|se|sp|sv|sr|st|skoid|sktid|skt|ske|sks|skv|token|access_token)$/i;
export const stripCred=u=>{try{const x=new URL(u);let gone=0;for(const k of[...x.searchParams.keys()])if(CRED.test(k)){x.searchParams.delete(k);gone++}return{url:gone?x.toString().replace(/\?$/,""):u,withheld:gone>0}}catch{return{url:u,withheld:false}}};
// a fresh presigned URL may stand in for a stored source, but only for the same object (same origin and path)
const sameObject=(a,b)=>{try{const x=new URL(a),y=new URL(b);return x.origin===y.origin&&x.pathname===y.pathname}catch{return false}};

// ---------- tiled maps (PMTiles v3): a 127-byte header, directories of tile ids, then the tiles ----------
const gunzip=async b=>new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
const pmDir=d=>{let p=0;const v=()=>{let r=0,m=1,b;do{b=d[p++];r+=(b&0x7f)*m;m*=128}while(b&0x80);return r};
 const n=v(),e=Array.from({length:n},()=>({}));let last=0;for(const x of e){last+=v();x.id=last}for(const x of e)x.run=v();for(const x of e)x.len=v();
 e.forEach((x,i)=>{const o=v();x.off=o===0&&i?e[i-1].off+e[i-1].len:o-1});return e};
const zxy=id=>{let acc=0,z=0;for(;z<32;z++){const n=4**z;if(acc+n>id)break;acc+=n}let t=id-acc,x=0,y=0;const n=2**z;
 for(let s=1;s<n;s*=2){const rx=Math.floor(t/2)%2,ry=(Math.floor(t)^rx)&1;if(ry===0){if(rx===1){x=s-1-x;y=s-1-y}[x,y]=[y,x]}x+=s*rx;y+=s*ry;t=Math.floor(t/4)}return`${z}/${x}/${y}`};
const pmtiles=async(url,tick)=>{
 const h=await range(url,0,127);if(new TextDecoder().decode(h.slice(0,7))!=="PMTiles"||h[7]!==3)throw new Error("Not a PMTiles v3 archive.");
 const dv=new DataView(h.buffer,h.byteOffset),u64=o=>Number(dv.getBigUint64(o,true)),i32=o=>dv.getInt32(o,true)/1e7;
 const H0={root:[u64(8),u64(16)],meta:[u64(24),u64(32)],leaf:u64(40),data:u64(56),tiles:u64(80),contents:u64(88),ic:h[97],tc:h[98],tt:h[99],minz:h[100],maxz:h[101],bbox:[i32(102),i32(106),i32(110),i32(114)],c:[i32(123),i32(119)]};
 const unz=async b=>H0.ic===2?gunzip(b):b;
 tick("reading the tile directory");
 const root=pmDir(await unz(await range(url,H0.root[0],H0.root[1])));
 const all=[{label:"header and root directory",offset:0,length:H0.root[0]+H0.root[1],dflt:true},...(H0.meta[1]?[{label:"metadata",offset:H0.meta[0],length:H0.meta[1],dflt:true}]:[])];
 let tiles=root.filter(e=>e.run>0);const leaves=root.filter(e=>e.run===0);
 // a big archive keeps its tiles in leaf directories: read the first two, so their tiles can be named
 for(const [k,l] of leaves.slice(0,2).entries()){all.push({label:`leaf directory ${k}`,offset:H0.leaf+l.off,length:l.len,dflt:true});tiles=tiles.concat(pmDir(await unz(await range(url,H0.leaf+l.off,l.len))).filter(e=>e.run>0))}
 let meta={};try{meta=JSON.parse(new TextDecoder().decode(await unz(await range(url,H0.meta[0],Math.min(H0.meta[1],262144)))))}catch{}
 const TYPE={1:"vector (MVT)",2:"PNG",3:"JPEG",4:"WebP",5:"AVIF"}[H0.tt]||"unknown",raster=[2,3,4,5].includes(H0.tt)&&H0.tc<=1,terrarium=/terrarium/i.test(JSON.stringify(meta)+url);
 const ts=tiles.map(e=>({label:`tile ${zxy(e.id)}${e.run>1?` (+${e.run-1} repeats)`:""}`,offset:H0.data+e.off,length:e.len}));
 const pickT=firstBy(ts,t=>t.label,8);
 const decode=raster&&typeof document!=="undefined"?async(b,label)=>{const im=await createImageBitmap(new Blob([b]));const cv=document.createElement("canvas");cv.className="grid";cv.width=im.width;cv.height=im.height;const g=cv.getContext("2d");g.drawImage(im,0,0);
  // terrarium tiles encode elevation in RGB (e = R·256 + G + B/256 − 32768): drawn as a hypsometric ramp, lit from the north-west
  if(terrarium){const W=cv.width,Hh=cv.height,d=g.getImageData(0,0,W,Hh),px=d.data,E=new Float32Array(W*Hh);for(let i=0;i<W*Hh;i++)E[i]=px[i*4]*256+px[i*4+1]+px[i*4+2]/256-32768;
   const L=[[-6000,[8,30,80]],[-200,[40,100,170]],[0,[120,180,220]],[1,[60,120,70]],[400,[120,160,85]],[1200,[190,175,115]],[2500,[150,115,85]],[4000,[235,235,235]]];
   const ramp=e=>{for(let k=1;k<L.length;k++)if(e<=L[k][0]){const[a0,c0]=L[k-1],[a1,c1]=L[k],t=Math.max(0,Math.min(1,(e-a0)/(a1-a0)));return c0.map((v,j)=>v+(c1[j]-v)*t)}return L.at(-1)[1]};
   for(let y=0;y<Hh;y++)for(let x=0;x<W;x++){const i=y*W+x,e=E[i],dx=E[y*W+Math.min(W-1,x+1)]-E[y*W+Math.max(0,x-1)],dy=E[Math.min(Hh-1,y+1)*W+x]-E[Math.max(0,y-1)*W+x],sh=e>0?Math.max(.55,Math.min(1.25,1-(dx-dy)/60)):1,c=ramp(e);
    px[i*4]=c[0]*sh;px[i*4+1]=c[1]*sh;px[i*4+2]=c[2]*sh;px[i*4+3]=255}g.putImageData(d,0,0)}
  g.font="bold 13px ui-monospace,monospace";g.fillStyle="rgba(0,0,0,.55)";g.fillRect(4,4,110,20);g.fillStyle="#fff";g.fillText(label,9,19);cv.dataset.date=label;return cv}:null;
 return{kind:`tiled map (PMTiles, ${TYPE} tiles)`,units:H0.contents||ts.length,frames:!!decode,
  all:[...all,...ts.map((t,k)=>({...t,dflt:pickT.has(t),...(decode&&pickT.has(t)?{decode:b=>decode(b,t.label.replace(/^tile /,"").replace(/ .*/,"")),grab:{video:true,t:k}}:{})}))],
  about:[`${(H0.contents||0).toLocaleString("en")} distinct tiles (${(H0.tiles||0).toLocaleString("en")} addressed), zoom ${H0.minz}–${H0.maxz}, ${TYPE}${terrarium?" (terrarium elevation, drawn as a ramp)":""}`,meta.name?`name: ${meta.name}`:"",meta.attribution?`attribution: ${String(meta.attribution).replace(/<[^>]+>/g,"").slice(0,160)}`:"",`the header and directories pin every tile's byte range; ${ts.length} tile entries were read from ${leaves.length?`the first ${Math.min(2,leaves.length)} of ${leaves.length} leaf directories`:"the root directory"}`].filter(Boolean),
  // a place only when the extent is a place: a whole-world archive has no centre worth naming
  ...(H0.bbox[2]-H0.bbox[0]<=20&&H0.bbox[3]-H0.bbox[1]<=20?{place:{lat:+(((H0.bbox[1]+H0.bbox[3])/2).toFixed(6)),lng:+(((H0.bbox[0]+H0.bbox[2])/2).toFixed(6)),bbox:H0.bbox}}:{})};
};

// ---------- tables (Parquet): the footer (Thrift compact) lists every row group's column chunks and their statistics ----------
const thrift=(b,p=0)=>{const zz=n=>n%2?-(n+1)/2:n/2;const vi=()=>{let r=0,m=1,x;do{x=b[p++];r+=(x&0x7f)*m;m*=128}while(x&0x80);return r};
 const val=t=>{switch(t){case 1:return true;case 2:return false;case 3:return b[p++];case 4:case 5:case 6:return zz(vi());case 7:{const d=new DataView(b.buffer,b.byteOffset+p,8).getFloat64(0,true);p+=8;return d}
  case 8:{const n=vi(),s=b.subarray(p,p+n);p+=n;return s}case 9:case 10:{const hd=b[p++];let n=hd>>4;const et=hd&15;if(n===15)n=vi();return Array.from({length:n},()=>et===1||et===2?b[p++]===1:val(et))}
  case 11:{const n=vi();if(!n)return[];const kt=b[p++];return Array.from({length:n},()=>[val(kt>>4),val(kt&15)])}case 12:return st();default:throw new Error("Parquet footer: unknown Thrift type "+t)}};
 const st=()=>{const o={};let id=0;for(;;){const x=b[p++];if(!x)return o;const d=x>>4,t=x&15;id=d?id+d:zz(vi());o[id]=val(t)}};
 return st()};
const shown=(v,type)=>{if(!(v instanceof Uint8Array))return"";const dv=new DataView(v.buffer,v.byteOffset,v.length);
 if(type===1&&v.length===4)return String(dv.getInt32(0,true));if(type===2&&v.length===8)return String(dv.getBigInt64(0,true));if(type===4&&v.length===4)return dv.getFloat32(0,true).toPrecision(6);if(type===5&&v.length===8)return dv.getFloat64(0,true).toPrecision(8);
 const t=new TextDecoder().decode(v);return/^[\x20-\x7e -￿]*$/.test(t)?JSON.stringify(t.slice(0,24)):`${v.length} bytes`};
const parquet=async(url,tick,bytes)=>{
 if(!bytes)throw new Error("Parquet needs the file size (the footer is at the end).");
 const tail=await range(url,bytes-8,8);if(new TextDecoder().decode(tail.slice(4))!=="PAR1")throw new Error("Not a Parquet file (no PAR1 at the end).");
 const n=new DataView(tail.buffer,tail.byteOffset).getUint32(0,true);if(n>64e6)throw new Error("Parquet footer is implausibly large.");
 tick("reading the footer");const fm=thrift(await range(url,bytes-8-n,n));
 const schema=(fm[2]||[]).map(e=>new TextDecoder().decode(e[4]||new Uint8Array())).slice(1),rgs=fm[4]||[],rows=fm[3]||0;
 const CODEC=["none","snappy","gzip","lzo","brotli","lz4","zstd","lz4_raw"];
 const cols=rgs.flatMap((rg,g)=>(rg[1]||[]).map(cc=>{const m=cc[3]||{},path=(m[3]||[]).map(x=>new TextDecoder().decode(x)).join("."),S=m[12]||{};
  const off=m[11]||m[9],len=m[7];
  return{label:`row group ${g} column ${path}`,offset:off,length:len,statsText:[S[6]||S[2]?`min ${shown(S[6]||S[2],m[1])}`:"",S[5]||S[1]?`max ${shown(S[5]||S[1],m[1])}`:"",S[3]!=null?`nulls ${S[3]}`:"",`${m[5]} values`,CODEC[m[4]]||""].filter(Boolean).join(" · ")}})).filter(c=>c.length>0);
 const pickC=firstBy(cols,c=>c.label,8);
 return{kind:"table (Parquet)",units:cols.length+1,
  all:[{label:"footer: schema, row groups, column chunks and their statistics",offset:bytes-8-n,length:n+8,dflt:true},...cols.map(c=>({...c,dflt:pickC.has(c),stats:()=>c.statsText}))],
  about:[`${Number(rows).toLocaleString("en")} rows, ${rgs.length} row group${rgs.length===1?"":"s"}, ${schema.length} columns: ${schema.slice(0,12).join(", ")}${schema.length>12?" …":""}`,fm[6]?`written by ${new TextDecoder().decode(fm[6]).slice(0,80)}`:"","one chunk per column per row group; each row carries the footer's own min, max and null count, so a changed column shows without reading it"].filter(Boolean)};
};

// ---------- vector features (FlatGeobuf): magic, a FlatBuffers header, a packed Hilbert R-tree, then the features ----------
const flatgeobuf=async(url,tick,bytes)=>{
 const m=await range(url,0,12);if(!(m[0]===0x66&&m[1]===0x67&&m[2]===0x62))throw new Error("Not a FlatGeobuf file.");
 const hl=new DataView(m.buffer,m.byteOffset).getUint32(8,true);if(hl>16e6)throw new Error("FlatGeobuf header is implausibly large.");
 const hb=await range(url,12,hl),dv=new DataView(hb.buffer,hb.byteOffset),tbl=dv.getUint32(0,true),vt=tbl-dv.getInt32(tbl,true),vts=dv.getUint16(vt,true);
 const at=i=>{const o=4+2*i;return o<vts?dv.getUint16(vt+o,true):0};
 const str=i=>{const o=at(i);if(!o)return"";const p=tbl+o+dv.getUint32(tbl+o,true),n=dv.getUint32(p,true);return new TextDecoder().decode(hb.subarray(p+4,p+4+n))};
 const env=(()=>{const o=at(1);if(!o)return null;const p=tbl+o+dv.getUint32(tbl+o,true),n=dv.getUint32(p,true);return Array.from({length:n},(_,k)=>dv.getFloat64(p+4+8*k,true))})();
 const count=at(8)?Number(dv.getBigUint64(tbl+at(8),true)):0,node=at(9)?dv.getUint16(tbl+at(9),true):16,GT=["mixed (per feature)","point","line","polygon","multipoint","multiline","multipolygon"][at(2)?hb[tbl+at(2)]:0]||"mixed";
 // the packed R-tree's size follows from the feature count and node size (40 bytes per node)
 let nodes=count,level=count;if(node>1&&count)while(level>1){level=Math.ceil(level/node);nodes+=level}
 const start=12+hl,idx=node&&count?nodes*40:0,feat=start+idx,end=bytes||feat,CH=4<<20,parts=[];for(let o=feat;o<end;o+=CH)parts.push({label:`features bytes ${o}…${Math.min(end,o+CH)-1}`,offset:o,length:Math.min(CH,end-o)});
 const pickP=new Set(spread(parts.length,6).map(i=>parts[i]));
 return{kind:`vector features (FlatGeobuf, ${GT})`,units:parts.length+(idx?2:1),
  all:[{label:"magic and header",offset:0,length:start,dflt:true},...(idx?[{label:"spatial index (packed Hilbert R-tree)",offset:start,length:idx,dflt:idx<=8<<20}]:[]),...parts.map(p=>({...p,dflt:pickP.has(p)}))],
  about:[`${count.toLocaleString("en")} ${GT} features${str(0)?` · ${str(0)}`:""}`,str(11)?`title: ${str(11)}`:"",`spatial index: ${nodes.toLocaleString("en")} nodes of up to ${node}`,env?`extent: ${env.map(v=>v.toFixed(3)).join(", ")}`:""].filter(Boolean),
  ...(env&&env.length>=4&&env[2]-env[0]<=20&&env[3]-env[1]<=20?{place:{lat:+(((env[1]+env[3])/2).toFixed(6)),lng:+(((env[0]+env[2])/2).toFixed(6)),bbox:env.slice(0,4)}}:{})};
};

const pick=u=>/\.copc\.laz(\?|$)/i.test(u)?copc:/\.nc(\?|$)|\.nc4(\?|$)|\.h5(\?|$)|\.hdf5?(\?|$)/i.test(u)?ncOrH5:/\.pmtiles(\?|$)/i.test(u)?pmtiles:/\.parquet(\?|$)/i.test(u)?parquet:/\.fgb(\?|$)/i.test(u)?flatgeobuf:/\.mp4(\?|$)|\.m4v(\?|$)|\.mov(\?|$)/i.test(u)?mp4:/\.jpe?g(\?|$)/i.test(u)?photo:/\.splat(\?|$)/i.test(u)||/\.ply(\?|$)/i.test(u)?splats:/\.safetensors(\?|$)/i.test(u)?safetensors:/\.gguf(\?|$)/i.test(u)?gguf:/\.m3u8(\?|$)/i.test(u)?hls:/\.zarr(\/|$)/i.test(u)?zarr:/\.dcm(\?|$)/i.test(u)?dicom:/\.tiff?(\?|$)/i.test(u)?tiff:null;
const FILEISH=/^(point:\s*)?https?:\/\/\S+?(\.pmtiles|\.fgb|\.m3u8|\.zarr\/?|\.dcm|\.safetensors|\.gguf|\.splat|\.ply|\.jpe?g|\.m4v|\.tiff?|\.nc|\.h5|\.hdf5|\.las|\.laz|\.parquet|\.mp4|\.mov|\.bin|\.zip)(\?\S*)?$|^point:\s*https?:\/\/\S+$/i;
// a folder: a Hugging Face repository (or a folder in it), or an S3 prefix ending in /
export const DIR=/^https:\/\/huggingface\.co\/(datasets\/|spaces\/)?[\w.-]+\/[\w.-]+(\/tree\/[^/\s]+(\/\S*)?)?\/?$|^https:\/\/[a-z0-9.-]+\.s3(\.[a-z0-9-]+)?\.amazonaws\.com\/\S*\/$/i;
// a wildlife observation (iNaturalist): its photograph is pointed at; species, time and place come with it
export const INAT=/^https:\/\/(?:www\.)?inaturalist\.org\/observations\/(\d+)\/?$/i;
export const POINTABLE={test:s=>FILEISH.test(s)||DIR.test(s)||INAT.test(s)};

// the rows of a pointer's table, with the optional stats column
export const parseRows=body=>[...body.matchAll(/^\| ([^|]+) \| (\S+) \| (\d+) \| (\d+) \| ([^|]+) \|(?: ([^|]*) \|)?$/gm)].filter(m=>m[1]!=="what"&&!/^-+$/.test(m[1])).map(m=>{const h=m[5].trim();return{label:m[1].trim(),url:m[2]==="·"?"":m[2],offset:+m[3],length:+m[4],hash:/^[a-z2-7]{52}$/.test(h)?h:ZERO,absent:!/^[a-z2-7]{52}$/.test(h),stats:(m[6]||"").trim()}});
const field=(body,k)=>(body.match(new RegExp(`^${k}: (.+)$`,"m"))||[])[1];

// the picture a pointer names, from decoded chunks: a mosaic of the smallest raster level, a scan, or splats seen from above
const assemble=(s,chunks)=>{
 if(s.preview)return s.preview;
 if(s.mosaic){const m=s.mosaic,got=chunks.filter(c=>c.pix&&c.grab);if(!got.length)return null;
  // colour: tiles decoded by the browser (JPEG) or pixel-interleaved samples, placed where they sit in the image
  if(got.some(c=>c.pix instanceof Object&&"width"in c.pix&&!(c.pix instanceof Float64Array)))return{kind:"tiles",w:m.w,h:m.h,tiles:got.map(c=>({...c.grab,img:c.pix}))};
  if(m.strips){// one row from each strip read, stacked: the whole picture, top to bottom, from a sample of its strips
   // every row of each strip read, stacked in order: the whole picture from a spread of its strips
   const strips=got.sort((a,b)=>a.grab.y-b.grab.y),W=m.w,spp=m.spp,sc=m.bits===16?1/257:1,H=strips.reduce((n,c)=>n+c.grab.th,0),data=new Uint8ClampedArray(W*H*4);let r=0;
   for(const c of strips)for(let j=0;j<c.grab.th;j++,r++)for(let x=0;x<W;x++){const o=(r*W+x)*4,i=(j*W+x)*spp;data[o]=c.pix[i]*sc;data[o+1]=c.pix[spp>1?i+1:i]*sc;data[o+2]=c.pix[spp>2?i+2:i]*sc;data[o+3]=255}
   return{kind:"rgba",w:W,h:H,data,aspect:m.h/m.w}}
  if(m.spp>=3){const data=new Uint8ClampedArray(m.w*m.h*4),sc=m.bits===16?1/257:1;
   for(const c of got){const{x,y,tw,th}=c.grab;for(let j=0;j<th&&y+j<m.h;j++)for(let i=0;i<tw&&x+i<m.w;i++){const q=(j*tw+i)*m.spp,o=((y+j)*m.w+x+i)*4;
    const r=c.pix[q],g=c.pix[q+1],b=c.pix[q+2];data.set([r*sc,g*sc,b*sc,(r===0&&g===0&&b===0)?0:255],o)}}
   return{kind:"rgba",w:m.w,h:m.h,data}}
  const v=new Float64Array(m.w*m.h).fill(NaN);
  for(const c of got){const{x,y,tw,th}=c.grab;for(let j=0;j<th&&y+j<m.h;j++)for(let i=0;i<tw&&x+i<m.w;i++){const q=c.pix[j*tw+i];v[(y+j)*m.w+x+i]=q===m.nodata?NaN:q}}
  return{kind:"grid",w:m.w,h:m.h,v}}
 // a gridded variable: one level of the first record read, as a map (north up)
 if(s.field){const c=chunks.filter(c=>c.pix).sort((a,b)=>a.offset-b.offset)[0];return c?{kind:"grid",w:s.field.w,h:s.field.h,v:c.pix,ramp:true}:null}
 if(s.points){const p=s.points();return p.xs.length?{kind:"points",...p}:null}
 if(s.frames){const f=chunks.filter(c=>c.pix&&c.grab?.video).sort((a,b)=>a.grab.t-b.grab.t).map(c=>c.pix);return f.length?{kind:"frames",frames:f}:null}
 return null;
};

// a pointer reopened: the same picture, drawn only from chunks that still hash to the pointer's rows
export const previewOf=async(body,tick=()=>{})=>{
 const src=field(body,"source"),rd=src&&pick(src);if(!rd||![tiff,dicom,splats,mp4,photo,pmtiles,ncOrH5].includes(rd))return null;
 const rows=new Map(parseRows(body).map(r=>[r.label,r])),{bytes}=await size(src).catch(()=>({}));
 const s=await rd(src,()=>{},bytes);
 if(s.preview){// a scan is read whole: every row must still match before its pixels are shown
  for(const c of s.all){const r=rows.get(c.label);if(r&&H(s.bytes.slice(c.offset,c.offset+c.length))!==r.hash)return null}return s.preview}
 let want=s.all.filter(c=>rows.has(c.label)&&((c.decode&&(s.mosaic||s.frames||s.field))||(s.sample&&/^splats/.test(c.label))));
 if(s.mosaic?.strips)want=want.filter((_,i,a)=>spread(a.length,96).includes(i));
 if(s.sample)want=want.filter((_,i,a)=>spread(a.length,4).includes(i));
 let n=0;
 await pool(want,6,async c=>{const b=await range(src,c.offset,c.length);if(H(b)!==rows.get(c.label).hash)return;
  if(c.decode&&(s.mosaic||s.frames||s.field))c.pix=await c.decode(b).catch(()=>null);if(s.sample)s.sample(c,b);tick(`${++n}/${want.length}`)});
 return assemble(s,want);
};

// read the structure, hash the chosen chunks from the source, and write the pointer's text
//  opts.have        an earlier pointer's text: its rows are kept (two are re-read to be sure), and it is named as extended
//  opts.more        how many more chunks to hash beyond the defaults, in H(label) order
//  opts.placeAbout  async ({lat,lng,bbox}) -> lines, to say where a raster is in emem's own terms
export const probe=async(raw,tick,opts={})=>{
 if(DIR.test(raw.trim()))return folder(raw.trim(),tick);
 const ob=raw.trim().match(INAT);
 if(ob){tick("reading the observation");const o=(await (await net(`https://api.inaturalist.org/v1/observations/${ob[1]}`)).json()).results?.[0];if(!o?.photos?.length)throw new Error("That observation has no photograph.");
  const ph=o.photos[0],[lat,lng]=(o.location||"").split(",").map(Number),t=o.taxon||{};
  return probe(ph.url.replace(/\/(square|small|medium|thumb|large)\./,"/original."),tick,{...opts,observation:{url:raw.trim(),species:t.name,common:t.preferred_common_name,rank:t.rank,when:o.time_observed_at||o.observed_on,lat,lng,place:o.place_guess,grade:o.quality_grade,license:ph.license_code||"all rights reserved",observer:o.user?.login}})}
 const url=raw.replace(/^point:\s*/i,"").trim(),host=new URL(url).host;
 tick("reading structure");
 const {bytes,etag}=await size(url).catch(()=>({}));
 let s;try{s=await(pick(url)||(()=>{throw new Error("plain")}))(url,tick,bytes)}catch(e){if(e.message!=="plain"&&!/read as a plain file/.test(e.message))throw e;s=bytes?await file(url,tick,bytes):await stream(url,tick)}
 const O=opts.observation;
 if(O){s.about=[`${O.common||O.species} (${O.species}), ${O.rank}; ${O.grade==="research"?"research grade: identification agreed by the community":O.grade}`,`observed ${String(O.when).slice(0,16).replace("T"," ")} at ${O.place||`${O.lat}, ${O.lng}`}, by ${O.observer}; photo ${O.license}`,`observation ${O.url}`,...s.about.filter(a=>!/no place in its EXIF|camera not recorded|time not recorded/.test(a))];
  if(!s.place&&Number.isFinite(O.lat))s.place={lat:+O.lat.toFixed(6),lng:+O.lng.toFixed(6),bbox:[O.lng,O.lat,O.lng,O.lat]};s.kind="wildlife observation (photograph)"}
 // which chunks: the defaults, whatever the earlier pointer already had, then the next ones in a fixed order anyone can repeat
 const prev=opts.have?parseRows(opts.have):[],had=new Map(prev.map(r=>[r.label,r]));
 if(opts.have){const pb=field(opts.have,"bytes");if(bytes&&/^\d+$/.test(pb||"")&&+pb!==bytes)throw new Error(`The source is now ${bytes} bytes; the pointer says ${pb}. It changed, so it is pointed at afresh, not extended.`)}
 const pickSet=new Set(s.all.filter(c=>c.dflt||had.has(c.label)));
 const more=Math.max(0,opts.more|0);
 if(more){const rest=s.all.filter(c=>!pickSet.has(c));(s.chained?rest:rest.map(c=>[order(c.label),c]).sort((a,b)=>a[0]<b[0]?-1:1).map(x=>x[1])).slice(0,more).forEach(c=>pickSet.add(c))}
 const chunks=s.all.filter(c=>pickSet.has(c));
 // a live chain keeps the rows whose segments have since left the playlist, so it grows instead of restarting
 const listed=new Set(s.all.map(c=>c.label));
 if(s.chained&&opts.have)chunks.unshift(...prev.filter(r=>!listed.has(r.label)&&!r.absent).map(r=>({label:r.label,url:r.url,offset:r.offset,length:r.length,hash:r.hash,kept:true,gone:true})));
 // rows carried over from the earlier pointer are not re-read, except a spread of two, which must still match
 const carried=chunks.filter(c=>had.has(c.label)&&!had.get(c.label).absent&&!c.gone); // expired live segments can't be re-read
 for(const i of spread(carried.length,2)){const c=carried[i],r=had.get(c.label),b=c.url?await whole(c.url):await range(url,r.offset,r.length);if(H(b)!==r.hash)throw new Error(`${c.label} no longer matches the pointer being extended; the source changed.`)}
 for(const c of carried){const r=had.get(c.label);Object.assign(c,{hash:r.hash,length:r.length,statsText:r.stats,kept:true})}
 let done=0,read=0,halted=null;
 // a Stop keeps what was already hashed: the rows so far become a partial pointer the person may choose to keep
 await pool(chunks,6,async c=>{
  if(c.hash){done++;if(!c.kept)read+=c.length;return}
  const b=s.bytes&&!c.url?s.bytes.slice(c.offset,c.offset+c.length):c.url&&c.ranged?await range(c.url,c.offset,c.length):c.url?await whole(c.url).catch(e=>e.status===404?null:Promise.reject(e)):await range(url,c.offset,c.length);
  if(b===null){c.absent=true;c.hash=ZERO;c.length=0}else{c.hash=H(b);if(c.url)c.length=b.length;read+=b.length;if(c.stats)c.statsText=await Promise.resolve(c.stats(b)).catch(()=>"");if(c.decode&&(s.mosaic||s.frames||s.field))c.pix=await c.decode(b).catch(()=>null);if(s.sample)s.sample(c,b)}
  tick(`${++done}/${chunks.length} chunks · ${mb(read)} read`);
 }).catch(e=>{if(!/^Stopped/.test(e.message))throw e;halted=e});
 if(halted){const got=chunks.filter(c=>c.hash);if(!got.length)throw halted;chunks.splice(0,chunks.length,...got)}
 for(const c of chunks)if(c.url===url)c.url="";else if(c.url)c.url=stripCred(c.url).url; // rows never carry a credential
 let total=s.streamed?s.bytes:s.whole?null:bytes,est=null;
 if(s.whole){const got=chunks.filter(c=>!c.absent&&/chunk|segment/.test(c.label));if(got.length)est=Math.round(got.reduce((a,c)=>a+c.length,0)/got.length*(s.units-s.all.filter(c=>!/chunk|segment/.test(c.label)).length))}
 const place=s.place&&opts.placeAbout&&!halted?await opts.placeAbout(s.place).catch(()=>[]):[];
 // a row at the source itself is written "·" and hashed with an empty url
 const r=s.chained?chain(chunks):root(chunks),name=decodeURIComponent(stripCred(url).url.split("?")[0].split("/").filter(Boolean).pop()||host),withStats=chunks.some(c=>c.statsText);
 const rows=chunks.map(c=>`| ${c.label} | ${c.url&&c.url!==url?stripCred(c.url).url:"·"} | ${c.offset} | ${c.length} | ${c.absent?"absent (fill value)":c.hash} |${withStats?` ${(c.statsText||"").replace(/\|/g,"/")} |`:""}`);
 const prevCid=opts.have?(opts.haveUrl||"").split("/").pop().replace(/\.md$/,""):"";
 const pub=stripCred(url);
 const body=`---\nemem: pointer.v1\nsource: ${pub.url}\n${pub.withheld?"credential: presigned URL withheld (never stored); re-read with a fresh one\n":""}bytes: ${total??(est?`about ${est} (estimated from the chunks read)`:"unknown")}\netag: ${etag||"not exposed"}\nkind: ${s.kind}\nchunks: ${chunks.length} of ${s.units} hashed${halted?" (stopped early: a partial pointer; more: continues it)":""}\n${s.chained?"chain":"root"}: ${r}\nhash: blake3-256 of each chunk's bytes\norder: defaults, then by blake3(label without type or shape)\n${prevCid?`extends: ${prevCid}\n`:""}${s.place?`place: ${s.place.lat},${s.place.lng}\nbbox: ${s.place.bbox.join(",")}\n`:""}---\n\n# ${name}\n\n> ${s.kind} at ${host}${total?`, ${mb(total)}`:est?`, about ${mb(est)}`:""}.\n\n${s.about.map(a=>"- "+a).join("\n")}\n- ${chunks.length} of ${s.units} chunks hashed${prevCid?`; extends ${prevCid}, whose ${carried.length} rows are kept and 2 of them re-read`:""}; more can be hashed later, in a fixed order, without re-reading these\n${place.length?`\n## Place\n\n${place.map(a=>"- "+a).join("\n")}\n`:""}\n## Chunks\n\n| what | url (· is the source) | offset | length | blake3 |${withStats?" stats |":""}\n|---|---|---|---|---|${withStats?"---|":""}\n${rows.join("\n")}\n`;
 const preview=assemble(s,chunks);
 if(halted)throw Object.assign(new Error(`Stopped after hashing ${chunks.length} chunks. Nothing was published.`),{partial:{body,url,name,kind:s.kind,bytes:total,est,read,chunks,units:s.units,rootHash:r,chained:!!s.chained,about:s.about,place:s.place,preview}});
 return{body,url,name,kind:s.kind,bytes:total,est,read,chunks,units:s.units,rootHash:r,chained:!!s.chained,about:s.about,place:s.place,preview};
};

// re-read a spread of chunks from the source and compare: is the data still what the pointer says?
export const recheck=async(body,tick,k=6,via)=>{
 const stored=field(body,"source");if(via&&!sameObject(via,stored))throw new Error("That fresh URL points at a different object than the pointer's source.");
 if(!via&&/^presigned/.test(field(body,"credential")||""))throw new Error(`This pointer's source is a private bucket. Re-read it with a fresh presigned URL: <pointer link> with <fresh URL for ${stored}>`);
 const src=via||stored,want=(body.match(/^(root|chain): (\S+)/m)||[]),all=parseRows(body),chunks=all.filter(c=>!c.absent);
 const table=want[1]==="chain"?chain(all)===want[2]:root(all)===want[2];
 let ok=0,n=0;const rows=[];
 for(const i of spread(chunks.length,k)){const c=chunks[i];const b=c.url&&/ (inner \d+|index)$/.test(c.label)?await range(c.url,c.offset,c.length):c.url?await whole(c.url):await range(src,c.offset,c.length);n++;const now=H(b),good=now===c.hash;if(good)ok++;rows.push({...c,now,ok:good});tick(`${n}/${Math.min(k,chunks.length)} from the source`)}
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

// ---------- a folder: the listing is read, never the files; each entry keeps the publisher's own content hash ----------
// Hugging Face gives sha256 for large (LFS) files and the git blob id for small ones; S3 gives the ETag (MD5 of a
// single-part upload; "-N" marks a multipart one). A row binds path, size and that hash; the root binds every row.
const list=async(url,tick)=>{
 const out=[];
 const hf=url.match(/^https:\/\/huggingface\.co\/(datasets\/|spaces\/)?([\w.-]+\/[\w.-]+)(?:\/tree\/([^/\s]+)(?:\/(\S*?))?)?\/?$/i);
 if(hf){const kind=hf[1]==="datasets/"?"datasets":hf[1]==="spaces/"?"spaces":"models",rev=hf[3]||"main",sub=(hf[4]||"").replace(/\/$/,"");
  let next=`https://huggingface.co/api/${kind}/${hf[2]}/tree/${rev}${sub?"/"+sub:""}?recursive=true&expand=false`;
  for(let page=0;next&&page<10;page++){const x=await net(next);if(!x.ok)throw new Error(`Hugging Face answered ${x.status} for ${hf[2]}.`);
   for(const e of await x.json())if(e.type==="file")out.push({path:e.path,size:e.size,hash:e.lfs?.oid?`sha256:${e.lfs.oid}`:`git-sha1:${e.oid}`,url:`https://huggingface.co/${hf[1]||""}${hf[2]}/resolve/${rev}/${e.path.split("/").map(encodeURIComponent).join("/")}`});
   next=((x.headers.get("link")||"").match(/<([^>]+)>;\s*rel="next"/)||[])[1];tick(`${out.length} files listed`)}
  return{out,truncated:!!next,host:"huggingface.co",name:`${hf[2]}${sub?"/"+sub:""} @ ${rev}`,kind:`Hugging Face ${kind.replace(/s$/,"")} repository`}}
 const u=new URL(url),prefix=decodeURIComponent(u.pathname.slice(1)),base=`${u.origin}/`;let token="";
 for(let page=0;page<10;page++){const x=await net(`${base}?list-type=2&prefix=${encodeURIComponent(prefix)}${token?`&continuation-token=${encodeURIComponent(token)}`:""}`);
  if(!x.ok)throw new Error(`${u.host} answered ${x.status} to a listing; the bucket may not allow public listing.`);
  const t=await x.text();
  for(const m of t.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)){const g=k=>(m[1].match(new RegExp(`<${k}>([^<]*)</${k}>`))||[])[1]||"";const key=g("Key").replace(/&amp;/g,"&");
   if(!key.endsWith("/"))out.push({path:key.slice(prefix.length),size:+g("Size"),hash:`etag:${g("ETag").replace(/&quot;|"/g,"")}`,url:base+key.split("/").map(encodeURIComponent).join("/")})}
  tick(`${out.length} files listed`);token=/<IsTruncated>true/.test(t)?(t.match(/<NextContinuationToken>([^<]+)</)||[])[1]:"";if(!token)break}
 return{out,truncated:!!token,host:u.host,name:prefix||u.host,kind:"S3 folder"};
};
const rowOf=f=>({url:f.url,offset:0,length:f.size,hash:H(U(`${f.path}\n${f.size}\n${f.hash}`))});
const folder=async(url,tick)=>{
 tick("reading the listing");
 const{out,host,name,kind,truncated}=await list(url,tick);if(!out.length)throw new Error("That folder lists no files.");
 out.sort((a,b)=>a.path<b.path?-1:1);
 const total=out.reduce((a,f)=>a+f.size,0),r=root(out.map(rowOf)),big=out.filter(f=>f.size>=64e6).length,pointable=out.filter(f=>FILEISH.test(f.url)).length;
 const exts=Object.entries(out.reduce((m,f)=>{const e=(f.path.match(/\.([a-z0-9]{1,12})$/i)||[,"(none)"])[1].toLowerCase();m[e]=(m[e]||0)+f.size;return m},{})).sort((a,b)=>b[1]-a[1]).slice(0,6);
 const about=[`${out.length} files, ${mb(total)} in all${big?`; ${big} of them over 64 MB`:""}`,`by size: ${exts.map(([e,n])=>`${e} ${mb(n)}`).join(", ")}`,
  `publisher hashes kept: ${[...new Set(out.map(f=>f.hash.split(":")[0]))].join(", ")}`,pointable?`${pointable} files can be pointed at chunk by chunk: paste a file's url`:""].filter(Boolean);
 const body=`---\nemem: directory.v1\nsource: ${url}\nfiles: ${out.length}\nlisted: ${truncated?"first 10 pages only (truncated): files beyond them are not named here":"complete"}\nbytes: ${total}\nkind: ${kind}\nroot: ${r}\nhash: each row is blake3(path, size, publisher hash); the root is a Merkle tree over (url, 0, size, row hash) in path order\n---\n\n# ${name}\n\n> ${kind} at ${host}: ${out.length} files, ${mb(total)}.\n\n${about.map(a=>"- "+a).join("\n")}\n\n## Files\n\n| path | url | bytes | publisher hash |\n|---|---|---|---|\n${out.map(f=>`| ${f.path.replace(/\|/g,"%7C")} | ${f.url} | ${f.size} | ${f.hash} |`).join("\n")}\n`;
 return{body,url,name,kind,bytes:total,est:null,read:0,chunks:out,units:out.length,rootHash:r,chained:false,about,folder:true};
};
// list the folder again and compare: which files are unchanged, changed, new or gone
export const relist=async(body,tick)=>{
 const src=field(body,"source"),want=field(body,"root");
 const was=new Map([...body.matchAll(/^\| (.+?) \| (https:\S+) \| (\d+) \| (\S+:\S+) \|$/gm)].map(m=>[m[1].replace(/%7C/g,"|"),{path:m[1].replace(/%7C/g,"|"),url:m[2],size:+m[3],hash:m[4]}]));
 const table=root([...was.values()].map(rowOf))===want;
 const{out,truncated}=await list(src,tick),now=new Map(out.map(f=>[f.path,f]));
 let same=0;const changed=[],added=[],gone=[],unseen=[];
 // a listing that stopped early (10 pages) says nothing about files it didn't reach: they are unseen, never "gone"
 for(const[p,f]of was){const g=now.get(p);if(!g)(truncated?unseen:gone).push(p);else if(g.size===f.size&&g.hash===f.hash)same++;else changed.push(p)}
 for(const p of now.keys())if(!was.has(p))added.push(p);
 return{src,table,same,changed,added,gone,unseen,truncated,n:was.size};
};

// ---------- a preview drawn from bytes that were hashed: a grid (raster, scan) or points seen from above (splats) ----------
export const drawPreview=pv=>{
 if(!pv||typeof document==="undefined")return null;
 const cv=document.createElement("canvas");cv.className="preview";
 // a field of measurements gets a perceptual ramp (viridis stops); scans and elevation stay grey
 const VIRIDIS=t=>{const S=[[68,1,84],[59,82,139],[33,145,140],[94,201,98],[253,231,37]],x=t*(S.length-1),i=Math.min(S.length-2,Math.floor(x)),f=x-i;return S[i].map((v,k)=>v+(S[i+1][k]-v)*f)};
 if(pv.kind==="grid"){const{w,h,v}=pv,sc=Math.min(1,320/Math.max(w,h)),W=Math.max(1,Math.round(w*sc)),Hh=Math.max(1,Math.round(h*sc));cv.width=W;cv.height=Hh;
  const vals=[];for(let i=0;i<v.length;i+=Math.max(1,Math.floor(v.length/20000)))if(Number.isFinite(v[i]))vals.push(v[i]);vals.sort((a,b)=>a-b);
  const lo=vals[Math.floor(vals.length*.02)]??0,hi=vals[Math.floor(vals.length*.98)]??1,g=cv.getContext("2d"),img=g.createImageData(W,Hh);
  for(let y=0;y<Hh;y++)for(let x=0;x<W;x++){const q=v[Math.floor(y/sc)*w+Math.floor(x/sc)],o=(y*W+x)*4;if(!Number.isFinite(q)){img.data[o+3]=0;continue}const f=Math.max(0,Math.min(1,(q-lo)/(hi-lo||1)));if(pv.ramp){const c=VIRIDIS(f);img.data.set([c[0],c[1],c[2],255],o)}else{const t=f*255;img.data.set([t,t,t,255],o)}}
  g.putImageData(img,0,0);return cv}
 if(pv.kind==="frames")return pv.frames[0];
 if(pv.kind==="rgba"){const h=Math.round(pv.aspect?pv.w*pv.aspect:pv.h),sc=Math.min(1,320/Math.max(pv.w,h));cv.width=Math.max(1,Math.round(pv.w*sc));cv.height=Math.max(1,Math.round(h*sc));
  const src=document.createElement("canvas");src.width=pv.w;src.height=pv.h;src.getContext("2d").putImageData(new ImageData(pv.data,pv.w,pv.h),0,0);
  const g=cv.getContext("2d");g.imageSmoothingQuality="high";g.drawImage(src,0,0,cv.width,cv.height);return cv}
 if(pv.kind==="tiles"){const sc=Math.min(1,320/Math.max(pv.w,pv.h));cv.width=Math.max(1,Math.round(pv.w*sc));cv.height=Math.max(1,Math.round(pv.h*sc));
  const g=cv.getContext("2d");g.imageSmoothingQuality="high";for(const t of pv.tiles)g.drawImage(t.img,t.x*sc,t.y*sc,t.img.width*sc,t.img.height*sc);return cv}
 if(pv.kind==="points"&&pv.xs.length){const S=320;cv.width=S;cv.height=S;const g=cv.getContext("2d"),q=(a,p)=>{const b=[...a].sort((x,y)=>x-y);return b[Math.floor(b.length*p)]};
  // seen from above: splat scenes are y-up or y-down, so the ground plane is x and z
  const A=pv.xs,B=pv.zs,a0=q(A,.03),a1=q(A,.97),b0=q(B,.03),b1=q(B,.97),s=Math.min(S/(a1-a0||1),S/(b1-b0||1)),ox=(S-(a1-a0)*s)/2,oy=(S-(b1-b0)*s)/2;
  g.fillStyle="#111";g.fillRect(0,0,S,S);
  for(let i=0;i<A.length;i++){const x=ox+(A[i]-a0)*s,y=S-oy-(B[i]-b0)*s;if(x<0||y<0||x>S||y>S)continue;const[r,gg,b]=pv.rgb[i];g.fillStyle=`rgba(${r},${gg},${b},.55)`;g.fillRect(x,y,1.3,1.3)}
  return cv}
 return null;
};
