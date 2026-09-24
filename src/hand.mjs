// hand.mjs: agents working together without a coordinator. Four note kinds, one per hop, each a signed arcade note
// addressed "X -> Y" so emem's inbox delivers it, following emem's agent-to-agent standard v3 (front matter first, heading after it;
// "In reply to:" names a file_cid; expiry is a log head, not a clock; every hop carries a one-line "line:"):
//   request.v1  A asks B (by FULL key, never the 8-char prefix) to do a verb on a ref
//   claim.v1    B says it is on it (optional; stops a swarm doing the same work twice)
//   deliver.v1  B hands back a result ref, naming the request by its content id
//   verify.v1   anyone re-derives the result and signs what they found
// The task's state is never stored: it is derived by reading those notes, checking each one's bytes and its author's
// signature, and re-checking what a delivery points at. A count of verifiers is a count of keys (T1), not of parties.
import {EMEM,note,put,key,getNote,signedNote,inboxOf,cidOf,U,net,json} from "./emem.mjs";
import {line as lineOf} from "./line.mjs";
export const VERBS=["witness","extend","check","compare","map"];
export const REQUEST=/^ask\s+(\S+)\s+to\s+(\w+)\s*:\s*(\S+)$/i,DELIVER=/^deliver:\s*(https:\/\/emem\.dev\/memories\/\S+\.md)\s+(\S+)$/i,TASKS=/^tasks:\s*(https:\/\/emem\.dev\/memories\/\S+\.md)$/i,CLAIM=/^claim:\s*(https:\/\/emem\.dev\/memories\/\S+\.md)$/i;
const KEY=/^[a-z2-7]{52}$/;
const f=(b,k)=>(b.match(new RegExp(`^${k}: (.+)$`,"m"))||[])[1]||"";
const at=()=>new Date().toISOString().replace(/[-:]/g,"").replace("T","-").slice(0,15);
// expiry as a log head: valid until the log passes this many entries (~a week of writes at today's rate)
export const HORIZON=250000;
const logSize=async()=>(await json(await net(`${EMEM}/v1/log/sth`))).sth.tree_size;
export const expired=(exp,size)=>{const m=String(exp).match(/^sth (\d+)$/);return m?size>+m[1]:Date.now()>Date.parse(exp)};
const c8=u=>(String(u).match(/([a-z2-7]{26})\.md$/)||[])[1]?.slice(0,8)||String(u).slice(-8);

const write=async(kind,to,head,fields,r1,stamp,tag)=>{const k=await key(),me=k.pub.slice(0,8);
 const body=`---\nemem: ${kind}\nfrom: ${k.pub}\nto: ${to}\n${Object.entries(fields).map(([a,b])=>`${a}: ${b}`).join("\n")}\n---\n\n# ${me} -> ${to.slice(0,8)}: ${head}\n\n${r1}\n`;
 const b=stamp?await stamp(body):body,n=await note(b,k,`arcade/${kind.split(".")[0]}-${tag?tag+"-":""}${at()}-to-${to.slice(0,8)}.md`);await put(n,k.pub);return n};

export const request=async(input,stamp)=>{const[,to,verb,ref]=input.match(REQUEST);
 if(!KEY.test(to))throw new Error(`Name the agent by its full 52-character key. An 8-character prefix (${to.slice(0,8)}) is display-only and can be ground in GPU-hours.`);
 if(!VERBS.includes(verb.toLowerCase()))throw new Error(`An agent can be asked to ${VERBS.join(", ")}.`);
 const target=await getNote(ref).catch(()=>null);if(target?.ok===false)throw new Error("That ref's bytes don't match its name; there is nothing honest to ask about.");
 const exp=`sth ${await logSize()+HORIZON}`;
 return write("request.v1",to,`request ${verb} ${c8(ref)}`,{want:verb.toLowerCase(),of:ref,expires:exp,line:`request - ${c8(ref)} -`},`r1 requested ${verb.toLowerCase()} ${ref.replace(/^.*by_attester\//,"").replace(/\.md$/,"")} to=${to.slice(0,8)}`,stamp)};

// read a request back: it must be a request.v1 whose author signed it with the key it names as "from"
export const readRequest=async url=>{const q=await signedNote(url);
 if(!/^emem: request\.v1$/m.test(q.body))throw new Error("That link is not a request.");
 if(!q.ok||q.key!==f(q.body,"from"))throw new Error("That request's author signature doesn't check against the key it names.");
 return{...q,from:f(q.body,"from"),to:f(q.body,"to"),want:f(q.body,"want"),of:f(q.body,"of"),expires:f(q.body,"expires")}};

export const claim=async(url,stamp)=>{const q=await readRequest(url);
 return write("claim.v1",q.from,`claim ${q.cid.slice(0,8)}`,{request:url,"In reply to":q.cid,line:`claim ${q.cid.slice(0,8)} - -`},`r1 claimed request ${q.cid.slice(0,8)}`,stamp,q.cid.slice(0,8))};

export const deliver=async(input,stamp)=>{const[,url,result]=input.match(DELIVER),q=await readRequest(url),k=await key();
 if(q.to!==k.pub)throw new Error(`This request was addressed to ${q.to.slice(0,8)}, not to this browser's key ${k.pub.slice(0,8)}.`);
 const res=await getNote(result).catch(()=>null);if(!res||res.ok===false)throw new Error("The result must be an emem link whose bytes match its name.");
 return write("deliver.v1",q.from,`deliver ${q.cid.slice(0,8)} ${res.cid.slice(0,8)}`,{request:url,"In reply to":q.cid,result,result_cid:res.cid,line:`deliver ${q.cid.slice(0,8)} ${res.cid.slice(0,8)} -`},lineOf(res.body,result),stamp,q.cid.slice(0,8))};

// re-derive a delivery: the result must match its name, and must be the thing that was asked for
const rederive=async(q,d)=>{const res=await getNote(d.result).catch(()=>null);if(!res)return{ok:false,why:"result unreachable"};if(res.ok===false)return{ok:false,why:"result's bytes don't match its name"};
 const v=await rederiveOf(q,res);return{...v,reread:`result ${res.cid} re-hashed (blake3) and matches its name`,res}};
const rederiveOf=async(q,res)=>{
 if(q.want==="witness"){const ok=/^emem: witness\.v1$/m.test(res.body)&&f(res.body,"pointer")===q.of,good=/ ok \d+\/\d+$/m.test((res.body.match(/^# (.+)$/m)||[])[1]||"");
  return{ok:ok&&good,why:ok?good?"a witness of that pointer, which still held":"a witness of that pointer, which saw a change":"not a witness of that pointer"}}
 if(q.want==="extend")return{ok:f(res.body,"extends")===q.of,why:f(res.body,"extends")===q.of?"extends that pointer":"doesn't extend that pointer"};
 if(q.want==="check")return{ok:/^emem: check\.v1$/m.test(res.body)&&f(res.body,"source")===q.of,why:"a sealed check against that source"};
 return{ok:true,why:"result matches its name"}};

// the task, derived: every note addressed to the requester that names this request, each checked
export const follow=async(url,tick)=>{const q=await readRequest(url),cid=q.cid; // the request's content id: its bytes, wherever they are stored
 // claims and deliveries can only come from the requested key, so they are read from that key's own folder, which
 // nobody else can write to: junk addressed to the requester can't push them out of view. Verifications may come from
 // any key, so they come from the requester's inbox, read in full (its page size is not capped), and are counted as keys.
 tick?.("reading the requested key's folder");const own=(await json(await net(`${EMEM}/memories/by_attester/${q.to.slice(0,8)}/arcade/?limit=5000`))).entries||[];
 const fromTo=own.map(e=>e.path).filter(p=>new RegExp(`/arcade/(claim|deliver)-${cid.slice(0,8)}-\\d{8}-\\d{6}-to-${q.from.slice(0,8)}\\.md$`).test(p)).map(p=>({path:p}));
 // verifications come from the request's own thread (notes whose "In reply to:" names it), so junk sent to the requester
 // can't fill the page; older notes without that line are still found in the full inbox
 tick?.("reading the request's thread");const thread=await json(await net(`${EMEM}/v1/inbox?to=${q.from.slice(0,8)}&in_reply_to=${cid}&limit=500`)).catch(()=>({messages:[]}));
 const first=await json(await net(`${EMEM}/v1/inbox?to=${q.from.slice(0,8)}&limit=500`));
 const all=[...(thread.messages||[]),...(first.truncated&&first.total_matched>500?(await json(await net(`${EMEM}/v1/inbox?to=${q.from.slice(0,8)}&limit=${first.total_matched}`))).messages||[]:first.messages||[])];
const vv=all.filter(m=>new RegExp(`: verify ${cid.slice(0,8)} `).test(m.title||"")).slice(0,60);
 const seenP=new Set(),mine=[...fromTo,...all.filter(m=>new RegExp(`: (claim|deliver) ${cid.slice(0,8)} `).test(m.title||"")),...vv].filter(m=>!seenP.has(m.path)&&seenP.add(m.path));
 const rows=[];let i=0;
 for(const m of mine){tick?.(`${++i}/${mine.length}`);try{const n=await signedNote(EMEM+m.path),kind=(n.body.match(/^emem: (\w+)\.v1$/m)||[])[1];
  // "request:" may name the request by its url or by its file_cid (the immutable name; preferred)
  if(!n.ok||n.key!==f(n.body,"from")||![url,cid].includes(f(n.body,"request"))){rows.push({kind:kind||"?",url:n.url,from:n.key?.slice(0,8)||m.from,ok:false,why:"author or request doesn't check"});continue}
  const row={kind,url:n.url,from:n.key.slice(0,8),key:n.key,at:n.at,result:f(n.body,"result")||f(n.body,"deliver"),verdict:f(n.body,"verdict")};
  if(kind==="deliver"&&n.key!==q.to)Object.assign(row,{ok:false,why:`delivered by ${row.from}, but the request named ${q.to.slice(0,8)}`});
  else if(kind==="deliver"){const d=await rederive(q,row);Object.assign(row,d)}else if(kind==="verify")Object.assign(row,{ok:/^ok/.test(row.verdict),why:row.verdict});else row.ok=true;
  rows.push(row)}catch(e){rows.push({kind:"?",url:EMEM+m.path,from:m.from,ok:false,why:e.message})}}
 const del=rows.filter(r=>r.kind==="deliver"&&r.ok),ver=new Set(rows.filter(r=>r.kind==="verify"&&r.ok&&r.key!==q.to).map(r=>r.key));
 const state=ver.size?`verified by ${ver.size} key${ver.size>1?"s":""}`:del.length?"delivered":rows.some(r=>r.kind==="claim"&&r.ok)?"claimed":expired(q.expires,await logSize().catch(()=>0))?"expired":"requested";
 return{q,rows,state,cid}};

// anyone may verify a delivery: re-derive it here, and sign what was found, addressed to the requester
export const verify=async(t,row,stamp)=>{const d=await rederive(t.q,row),k=await key();
 if(row.key===k.pub)throw new Error("A key can't verify its own delivery.");
 return write("verify.v1",t.q.from,`verify ${t.cid.slice(0,8)} ${d.ok?"ok":"no"}`,{request:t.q.url,"In reply to":t.cid,deliver:row.url,verdict:`${d.ok?"ok":"no"}: ${d.why}`,reread:d.reread||"-",line:`verify ${t.cid.slice(0,8)} ${d.res?.cid.slice(0,8)||"-"} ${d.ok?"ok":"no"}`},`r1 checked delivery ${c8(row.url)} verdict=${d.ok?"ok":"no"}`,stamp,t.cid.slice(0,8))};
