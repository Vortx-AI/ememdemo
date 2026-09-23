// line.mjs: one line per result, verbs first, for agents. Pure: the page, the seal tool and any agent derive the same line.
//
//   r1 <verb> <noun> <ref> key=value …
//   ref  <attester8>/<cid>  → https://emem.dev/memories/by_attester/<ref>.md   (or an emem:… token as is)
//   read the link; its name must equal base32(blake3(bytes))[0:26]. Each note names its schema: spec=<cid>.
// A line costs about 30 tokens; the note behind it is fetched only when a task needs it.
const f=(b,k)=>(b.match(new RegExp(`^${k}: (.+)$`,"m"))||[])[1]||"";
const sq=v=>String(v).trim().replace(/,\s+/g,",").replace(/\s+/g,"_");
const mb=n=>!n?"":n>=1e9?(n/1e9).toFixed(2)+"GB":n>=1e6?(n/1e6).toFixed(1)+"MB":(n/1e3).toFixed(1)+"KB";
const short=u=>sq(String(u).replace(/^https?:\/\//,"").replace(/^(.{24}).*(.{22})$/,"$1…$2"));
const KIND=[[/BigTIFF/i,"bigtiff"],[/GeoTIFF/i,"cog"],[/safetensors/i,"safetensors"],[/GGUF/i,"gguf"],[/Zarr/i,"zarr"],[/HLS/i,"hls"],[/DICOM/i,"dicom"],[/video/i,"mp4"],[/observation/i,"observation"],[/photograph/i,"jpeg"],[/splats/i,"splats"],[/file/i,"file"]];
export const refOf=url=>{const m=String(url).match(/by_attester\/([a-z2-7]{8})\/(.+)\.md$/);return m?`${m[1]}/${m[2]}`:String(url)};
// brief: for a catalog, only what chooses an item; hash-valued keys (root, bundle, rasterset, head, sth, spec) live in the note, one fetch away
const HASHY=/^(root|rasterset|bundle|head|sth|spec)=/;
export const line=(body,url,brief)=>{const l=full(body,url);if(!brief)return l;
 const host=(f(body,"source").match(/^https?:\/\/([^/]+)/)||[])[1];
 return l.split(" ").filter(w=>!HASHY.test(w)).map(w=>w.startsWith("src=")&&host?"src="+host:w.startsWith("at=")?w.replace(/(\.\d{3})\d+/g,"$1"):w).join(" ")};
const full=(body,url)=>{
 const ref=refOf(url),k=f(body,"emem"),sth=(body.match(/^after: sth (\d+)/m)||[])[1],spec=f(body,"spec"),tail=[sth?`sth=${sth}`:"",spec?`spec=${spec.slice(0,10)}`:""].filter(Boolean).join(" ");
 const L=(verb,noun,...kv)=>["r1",verb,noun,ref,...kv.filter(Boolean),tail].filter(Boolean).join(" ");
 if(k==="pointer.v1"){const kind=(KIND.find(([re])=>re.test(f(body,"kind")))||[,"file"])[1],b=f(body,"bytes").match(/(about )?(\d+)/);
  return L("pointed",kind,`src=${short(f(body,"source"))}`,b?`size=${b[1]?"~":""}${mb(+b[2])}`:"",`hashed=${f(body,"chunks").replace(/ of /,"/").replace(/ hashed$/,"")}`,`root=${(f(body,"root")||f(body,"chain")).slice(0,10)}`,f(body,"place")?`at=${f(body,"place")}`:"",f(body,"extends")?`extends=${f(body,"extends")}`:"")}
 if(k==="directory.v1")return L("listed","folder",`src=${short(f(body,"source"))}`,`files=${f(body,"files")}`,`size=${mb(+f(body,"bytes"))}`,`root=${f(body,"root").slice(0,10)}`);
 if(k==="world.v1")return L("sensed","place",`at=${sq(f(body,"at"))}`,`facts=${(body.match(/ · emem:fact:/g)||[]).length}`,f(body,"bundle")&&f(body,"bundle")!=="none"?`bundle=${f(body,"bundle")}`:"",/^## drift/m.test(body)?"drift":"",(body.match(/echo-verified by emem against its token: (\d+) of (\d+)/)||[]).slice(1).join("/")?`echo=${(body.match(/echo-verified by emem against its token: (\d+) of (\d+)/)||[]).slice(1).join("/")}`:"");
 if(k==="grid.v1")return L("mapped",f(body,"kind")||"grid",`at=${sq(f(body,"at"))}`,`grid=${(f(body,"grid").match(/^(\d+)×(\d+)/)||[]).slice(1).join("x")}`,`bands=${f(body,"bands").trim().split(/\s+/).join(",")}`,`receipts=${(f(body,"receipts").match(/^(\d+ of \d+)/)||[])[1]?.replace(" of ","/")||""}`);
 if(k==="timelapse.v1"){const d=[...body.matchAll(/^\| (\d{4})-\d\d-\d\d \|/gm)].map(m=>m[1]);return L("framed","timelapse",`at=${sq(f(body,"at"))}`,`frames=${f(body,"frames").split(" ")[0]}`,d.length?`years=${d[0]}-${d.at(-1)}`:"",f(body,"rasterset")?`rasterset=${f(body,"rasterset")}`:"")}
 if(k==="camera.v1")return L("surveyed","cameras",`n=${f(body,"cameras")}`,`clips=${(f(body,"clips").match(/^(\d+ of \d+)/)||[])[1]?.replace(" of ","/")}`,`sun=${(f(body,"sun").match(/^(\d+ of \d+)/)||[])[1]?.replace(" of ","/")}`);
 if(k==="track.v1")return L("chained","track",`steps=${f(body,"steps")}`,`checked=${f(body,"verified").replace(" of ","/")}`,`head=${f(body,"head").slice(0,10)}`);
 if(k==="compare.v1")return L("diffed","pointers",`same=${f(body,"same")}`,`changed=${f(body,"changed")}`,`only=${f(body,"only_a")}+${f(body,"only_b")}`);
 if(k==="witness.v1")return L("witnessed","pointer",`of=${refOf(f(body,"pointer"))}`,`read=${(f(body,"read").match(/^(\d+ of \d+)/)||[])[1]?.replace(" of ","/")}`);
 if(k==="check.v1")return L("checked","answer",`against=${refOf(f(body,"source"))}`,`guard=${sq(f(body,"guard"))}`);
 if(k==="thumb.v1")return L("drew","thumb",`of=${refOf(f(body,"of"))}`,`frames=${f(body,"frames")}`);
 if(k==="issue-state.v1")return L("probed","issue",`id=${f(body,"issue")}`,`holds=${f(body,"holds")}`);
 const secs=(body.match(/^- \[[^\]]+\]\(https:\/\/emem\.dev\/memories\//gm)||[]).length;
 return secs?L("indexed","doc",`sections=${secs}`,`title=${sq((body.match(/^# (.+)$/m)||[])[1]||"").slice(0,48)}`):L("stored","text",`title=${sq((body.match(/^(?:section|source): (.+)$/m)||[])[1]||"").slice(0,48)}`);
};
// a token from the family, as a line: the verb is what an agent does with it
export const tokenLine=t=>{const m=String(t).match(/^emem:([a-z]+):/);return m?`r1 resolve ${m[1]} ${t}`:/log\/sth/.test(t)?`r1 pin log ${t}`:`r1 open note ${t}`};
