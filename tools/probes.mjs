// probes.mjs: each open item that depends on emem.dev, as a check anyone can run again.
// A probe returns {holds, observed}: holds is true when emem.dev already does what the issue asks for.
// tools/issue-state.mjs runs them and stores each result on emem as a signed, log-stamped note (emem: issue-state.v1),
// so an issue's state is not a sentence someone typed but a record anyone can recompute.
const E="https://emem.dev";
const get=async(u,init)=>{const x=await fetch(u,init);const t=await x.text();let j=null;try{j=JSON.parse(t)}catch{}return{status:x.status,text:t,j}};
const post=(u,b)=>get(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)});
const CELL="defi.zb493.yiwo.zcb4e",LONDON="defi.zb64a.cAzU.zfa27";

export const PROBES=[
 {id:"notes-in-log",title:"Memory notes are not in the transparency log, so a note has no upper-bound timestamp",
  ask:"Log every memory write (or its file_cid) as a transparency-log entry and serve /v1/log/inclusion?entry_hash=<blake3 of the note> for it.",
  // a note written after emem logged memory writes, hashed here: the hash asked for is a note's own content hash
  // (patch from k572x7go, 2026-09-24: the old probe hashed a data chunk, which is never a log entry)
  run:async()=>{const N=`${E}/memories/by_attester/k572x7go/reply-ddzmyzhn-four-questions-2026-09-23.md`;
   const bytes=new Uint8Array(await (await fetch(N)).arrayBuffer());const A="abcdefghijklmnopqrstuvwxyz234567";let b=0,v=0,h="";
   for(const x of globalThis.ememCrypto.blake3(bytes)){v=(v<<8)|x;b+=8;while(b>=5){h+=A[(v>>>(b-5))&31];b-=5}}if(b>0)h+=A[(v<<(5-b))&31];
   const r=await get(`${E}/v1/log/inclusion?entry_hash=${h}`);
   return{holds:r.status===200&&r.j?.matched==="memory_note_content",observed:{note:N,content_blake3:h,status:r.status,matched:r.j?.matched,leaf_index:r.j?.leaf_index,tree_size:r.j?.tree_size}}}},
 {id:"perception-receipts",title:"geo.qa clip receipts answer 500, so a clip's signature cannot be checked",
  ask:"Make GET /v1/perception/verify/clip/<clip_cid> return the signed geoqa.clip.v1 receipt, with the canonical payload and signature needed to verify it against /verify/key.",
  run:async()=>{const c=await get(`${E}/v1/perception/cards`),p=c.j?.places?.[0];const svg=p?await (await fetch(`${E}/v1/perception/cards/${p.slug}/latest.svg`)).text():"";
   const cid=(svg.match(/clip_cid&quot;: &quot;([0-9a-f]{64})/)||[])[1];const r=cid?await get(`${E}/v1/perception/verify/clip/${cid}`):{status:0,text:"no clip_cid found"};
   return{holds:r.status===200,observed:{clip_cid:cid,status:r.status,body:r.text.slice(0,200)}}}},
 {id:"perception-routes",title:"Perception routes at a cell (at, history, trend, postcard) answer 500",
  ask:"Make GET /v1/perception/{at,history,trend,postcard}?cell=<cell64> answer for a cell the camera registry knows (Trafalgar Square), or return a typed error that names what is missing.",
  run:async()=>{const o={};for(const r of["at","history","trend","postcard"])o[r]=(await get(`${E}/v1/perception/${r}?cell=${LONDON}`)).status;return{holds:Object.values(o).every(s=>s===200),observed:{...o,note:Object.values(o).some(s=>s===502)?"502 = emem answered; the perception service upstream failed (code upstream_failed)":undefined}}}},
 {id:"ledger-idempotent",title:"change_attribution mints a new ledger fact on every call for the same inputs",
  ask:"Make the change ledger's fact_cid a function of its inputs (cell and the input fact_cids), so the same question gives the same token and tokens can be compared and cached.",
  run:async()=>{const a=await post(`${E}/v1/change_attribution`,{cell:CELL}),b=await post(`${E}/v1/change_attribution`,{cell:CELL});
   const x=a.j?.ledger_fact?.fact_cid,y=b.j?.ledger_fact?.fact_cid;return{holds:!!x&&x===y,observed:{first:x,second:y,inputs_equal:JSON.stringify(a.j?.input_fact_cids)===JSON.stringify(b.j?.input_fact_cids)}}}},
 {id:"history-seeded",title:"Year-over-year drift is unanswerable at popular cells: no history is seeded",
  ask:"Backfill enough history (at least one sample either side of each day-of-year for the last three years) for indices.ndvi at gallery cells, or let compare_same_doy trigger the backfill it needs.",
  run:async()=>{const r=await post(`${E}/v1/compare_same_doy`,{cell:CELL,band:"indices.ndvi",doy:266,years:[2023,2024,2025]});return{holds:(r.j?.included||[]).length>=2,observed:{included:r.j?.included,excluded:r.j?.excluded}}}},
 {id:"scene-thumbnail",title:"The Sentinel-2 scene thumbnail answers 404 at a gallery cell",
  ask:"Serve /v1/cells/<cell64>/scene.png wherever band facts exist, or return a typed reason (no clear scene, not materialised).",
  run:async()=>{const r=await fetch(`${E}/v1/cells/${CELL}/scene.png`);return{holds:r.status===200,observed:{status:r.status,type:r.headers.get("content-type")}}}},
 {id:"trace-example",title:"No public emem:trace or emem:attestation exists to demonstrate device traces",
  ask:"Publish one enrolled demo device (listed on /v1/devices) with a trace and a platform attestation, so emem:trace and emem:attestation tokens can be resolved and shown.",
  run:async()=>{const r=await get(`${E}/v1/devices`);return{holds:(r.j?.count||0)>0,observed:{devices:r.j?.count}}}},
 {id:"splat-worlds",title:"No baked Gaussian-splat worlds are served",
  ask:"Bake at least one world under /v1/worlds, or accept an external splat pointer (emem: pointer.v1 of a .splat or .ply) as a world token tied to a cell.",
  run:async()=>{const r=await get(`${E}/v1/worlds`);return{holds:(r.j?.count||0)>0,observed:{count:r.j?.count}}}},
 {id:"witness-sybil",title:"Any key can co-sign the log head, so witness counts are Sybil-cheap",
  ask:"Give witnesses an identity tier (enlist level, vouching, or proof of an independent operator) and report independent witnesses by tier, so a swarm of fresh keys cannot inflate them.",
  // holds when witnesses are reported by identity tier and independent operators are counted (patch from k572x7go, 2026-09-24)
  run:async()=>{const r=await get(`${E}/v1/log/witnesses?limit=1`);const t=r.j?.witness_keys_by_tier;return{holds:typeof r.j?.independent_operator_count==="number"&&!!t,observed:{witness_keys_by_tier:t,independent_operator_count:r.j?.independent_operator_count,independent_operator_domains:r.j?.independent_operator_domains,head_is_witnessed_by_independent_operator:r.j?.head_is_witnessed_by_independent_operator}}}},
 {id:"authorship-v2",title:"The authorship block describes the v1 signing preimage even for v2-signed notes",
  ask:"Report the preimage version actually signed in emem_memory_view's authorship block, so a verifier does not have to try both.",
  run:async()=>{const r=await post(`${E}/a2a/tasks`,{skill:"emem_memory_view",args:{file_cid:"aczo4t4lqajwljebeifv2wrpxy"}});const a=r.j?.artifacts?.[0]?.parts?.[0]?.data?.authorship||{};
   // this note was signed with the v2 preimage; the block should say so
   return{holds:/memory_write\.v2/.test(a.preimage||""),observed:{verb:a.verb,preimage_described:a.preimage}}}},
 {id:"mcp-browser",title:"The MCP endpoint refuses browser origins",
  ask:"Allow browser origins on /mcp/full for read tools (writes can stay on A2A), so a web page can speak MCP directly.",
  run:async()=>{const r=await get(`${E}/mcp/full`,{method:"POST",headers:{"content-type":"application/json",origin:"https://vortx-ai.github.io",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})});
   return{holds:r.status===200&&!/Origin not allowed/.test(r.text),observed:{status:r.status,body:r.text.slice(0,160)}}}},
 {id:"range-hash",title:"emem cannot hash a byte range of a remote file itself",
  ask:"Add a signed range-hash primitive: POST {url, offset, length} returns blake3 of those bytes as fetched by emem, with a receipt. A pointer could then be witnessed by emem itself, next to the data, without a browser moving the bytes.",
  run:async()=>{const r=await get(`${E}/openapi.json`);const has=/range_hash|hash_range|byte_range/.test(r.text);return{holds:has,observed:{openapi_mentions_range_hash:has}}}},
 {id:"note-kinds",title:"emem does not understand pointer, directory, world, camera, compare or witness notes",
  ask:"Register these note schemas (emem: pointer.v1, directory.v1, world.v1, camera.v1, compare.v1, witness.v1, issue-state.v1) so emem-guard and resolvers can check citations into them (a chunk hash, a file row, a clip hash).",
  run:async()=>{const r=await get(`${E}/v1/schemas`);const has=/pointer\.v1/.test(r.text);return{holds:has,observed:{schemas_mention_pointer_v1:has}}}},
 {id:"tree-proofs",title:"No per-chunk inclusion proof for a note's Merkle table",
  ask:"Serve an emem:tree view of a pointer or index: given a row, return its audit path to the note's root, so an agent checks one chunk with log2(n) hashes instead of downloading the whole table.",
  run:async()=>{const r=await get(`${E}/openapi.json`);const has=/emem:tree/.test(r.text);return{holds:has,observed:{openapi_mentions_emem_tree:has}}}},
];
