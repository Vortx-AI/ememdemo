// hand.mjs: agents working together without a coordinator. Four note kinds, one per hop, each a signed arcade note
// addressed "X -> Y" so emem's inbox delivers it, following emem's agent-to-agent standard v2:
//   request.v1  A asks B (by FULL key, never the 8-char prefix) to do a verb on a ref
//   claim.v1    B says it is on it (optional; stops a swarm doing the same work twice)
//   deliver.v1  B hands back a result ref, naming the request by its content id
//   verify.v1   anyone re-derives the result and signs what they found
// The task's state is never stored: it is derived by reading those notes, checking each one's bytes and its author's
// signature, and re-checking what a delivery points at. A count of verifiers is a count of keys (T1), not of parties.
import {EMEM,note,put,key,getNote,signedNote,inboxOf,cidOf,U} from "./emem.mjs";
import {line as lineOf} from "./line.mjs";
export const VERBS=["witness","extend","check","compare","map"];
export const REQUEST=/^ask\s+(\S+)\s+to\s+(\w+)\s*:\s*(\S+)$/i,DELIVER=/^deliver:\s*(https:\/\/emem\.dev\/memories\/\S+\.md)\s+(\S+)$/i,TASKS=/^tasks:\s*(https:\/\/emem\.dev\/memories\/\S+\.md)$/i,CLAIM=/^claim:\s*(https:\/\/emem\.dev\/memories\/\S+\.md)$/i;
const KEY=/^[a-z2-7]{52}$/;
const f=(b,k)=>(b.match(new RegExp(`^${k}: (.+)$`,"m"))||[])[1]||"";
const at=()=>new Date().toISOString().replace(/[-:]/g,"").replace("T","-").slice(0,15);
const c8=u=>(String(u).match(/([a-z2-7]{26})\.md$/)||[])[1]?.slice(0,8)||String(u).slice(-8);

const write=async(kind,to,head,fields,r1,stamp)=>{const k=await key(),me=k.pub.slice(0,8);
 const body=`# ${me} -> ${to.slice(0,8)}: ${head}\n\n---\nemem: ${kind}\nfrom: ${k.pub}\nto: ${to}\n${Object.entries(fields).map(([a,b])=>`${a}: ${b}`).join("\n")}\n---\n\n${r1}\n`;
 const b=stamp?await stamp(body):body,n=await note(b,k,`arcade/${kind.split(".")[0]}-${at()}-to-${to.slice(0,8)}.md`);await put(n,k.pub);return n};

export const request=async(input,stamp)=>{const[,to,verb,ref]=input.match(REQUEST);
 if(!KEY.test(to))throw new Error(`Name the agent by its full 52-character key. An 8-character prefix (${to.slice(0,8)}) is display-only and can be ground in GPU-hours.`);
 if(!VERBS.includes(verb.toLowerCase()))throw new Error(`An agent can be asked to ${VERBS.join(", ")}.`);
 const target=await getNote(ref).catch(()=>null);if(target?.ok===false)throw new Error("That ref's bytes don't match its name; there is nothing honest to ask about.");
 const exp=new Date(Date.now()+7*864e5).toISOString().slice(0,19)+"Z";
 return write("request.v1",to,`request ${verb} ${c8(ref)}`,{want:verb.toLowerCase(),of:ref,expires:exp},`r1 requested ${verb.toLowerCase()} ${ref.replace(/^.*by_attester\//,"").replace(/\.md$/,"")} to=${to.slice(0,8)}`,stamp)};

// read a request back: it must be a request.v1 whose author signed it with the key it names as "from"
export const readRequest=async url=>{const q=await signedNote(url);
 if(!/^emem: request\.v1$/m.test(q.body))throw new Error("That link is not a request.");
 if(!q.ok||q.key!==f(q.body,"from"))throw new Error("That request's author signature doesn't check against the key it names.");
 return{...q,from:f(q.body,"from"),to:f(q.body,"to"),want:f(q.body,"want"),of:f(q.body,"of"),expires:f(q.body,"expires")}};

export const claim=async(url,stamp)=>{const q=await readRequest(url);
 return write("claim.v1",q.from,`claim ${q.cid.slice(0,8)}`,{request:url},`r1 claimed request ${q.cid.slice(0,8)}`,stamp)};

export const deliver=async(input,stamp)=>{const[,url,result]=input.match(DELIVER),q=await readRequest(url),k=await key();
 if(q.to!==k.pub)throw new Error(`This request was addressed to ${q.to.slice(0,8)}, not to this browser's key ${k.pub.slice(0,8)}.`);
 const res=await getNote(result).catch(()=>null);if(!res||res.ok===false)throw new Error("The result must be an emem link whose bytes match its name.");
 return write("deliver.v1",q.from,`deliver ${q.cid.slice(0,8)} ${res.cid.slice(0,8)}`,{request:url,result},lineOf(res.body,result),stamp)};

// re-derive a delivery: the result must match its name, and must be the thing that was asked for
const rederive=async(q,d)=>{const res=await getNote(d.result).catch(()=>null);if(!res)return{ok:false,why:"result unreachable"};if(res.ok===false)return{ok:false,why:"result's bytes don't match its name"};
 if(q.want==="witness"){const ok=/^emem: witness\.v1$/m.test(res.body)&&f(res.body,"pointer")===q.of,good=/ ok \d+\/\d+$/m.test((res.body.match(/^# (.+)$/m)||[])[1]||"");
  return{ok:ok&&good,why:ok?good?"a witness of that pointer, which still held":"a witness of that pointer, which saw a change":"not a witness of that pointer"}}
 if(q.want==="extend")return{ok:f(res.body,"extends")===q.of,why:f(res.body,"extends")===q.of?"extends that pointer":"doesn't extend that pointer"};
 if(q.want==="check")return{ok:/^emem: check\.v1$/m.test(res.body)&&f(res.body,"source")===q.of,why:"a sealed check against that source"};
 return{ok:true,why:"result matches its name"}};

// the task, derived: every note addressed to the requester that names this request, each checked
export const follow=async(url,tick)=>{const q=await readRequest(url),cid=q.cid; // the request's content id: its bytes, wherever they are stored
 tick?.("reading the requester's inbox");const inbox=await inboxOf(q.from.slice(0,8));
 const mine=inbox.filter(m=>new RegExp(`: (claim|deliver|verify) ${cid.slice(0,8)}`).test(m.title||"")).slice(0,40);
 const rows=[];let i=0;
 for(const m of mine){tick?.(`${++i}/${mine.length}`);try{const n=await signedNote(EMEM+m.path),kind=(n.body.match(/^emem: (\w+)\.v1$/m)||[])[1];
  if(!n.ok||n.key!==f(n.body,"from")||f(n.body,"request")!==url){rows.push({kind:kind||"?",url:n.url,from:n.key?.slice(0,8)||m.from,ok:false,why:"author or request doesn't check"});continue}
  const row={kind,url:n.url,from:n.key.slice(0,8),key:n.key,at:n.at,result:f(n.body,"result")||f(n.body,"deliver"),verdict:f(n.body,"verdict")};
  if(kind==="deliver"&&n.key!==q.to)Object.assign(row,{ok:false,why:`delivered by ${row.from}, but the request named ${q.to.slice(0,8)}`});
  else if(kind==="deliver"){const d=await rederive(q,row);Object.assign(row,d)}else if(kind==="verify")Object.assign(row,{ok:/^ok/.test(row.verdict),why:row.verdict});else row.ok=true;
  rows.push(row)}catch(e){rows.push({kind:"?",url:EMEM+m.path,from:m.from,ok:false,why:e.message})}}
 const del=rows.filter(r=>r.kind==="deliver"&&r.ok),ver=new Set(rows.filter(r=>r.kind==="verify"&&r.ok&&r.key!==q.to).map(r=>r.key));
 const state=ver.size?`verified by ${ver.size} key${ver.size>1?"s":""}`:del.length?"delivered":rows.some(r=>r.kind==="claim"&&r.ok)?"claimed":Date.now()>Date.parse(q.expires)?"expired":"requested";
 return{q,rows,state,cid}};

// anyone may verify a delivery: re-derive it here, and sign what was found, addressed to the requester
export const verify=async(t,row,stamp)=>{const d=await rederive(t.q,row),k=await key();
 if(row.key===k.pub)throw new Error("A key can't verify its own delivery.");
 return write("verify.v1",t.q.from,`verify ${t.cid.slice(0,8)} ${d.ok?"ok":"no"}`,{request:t.q.url,deliver:row.url,verdict:`${d.ok?"ok":"no"}: ${d.why}`},`r1 checked delivery ${c8(row.url)} verdict=${d.ok?"ok":"no"}`,stamp)};
