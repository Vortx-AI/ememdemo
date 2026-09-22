const RESPONDER="https://emem.dev";
const $=(s,r=document)=>r.querySelector(s);
const request=async(path,{method="GET",body}={})=>{
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),15000);
  try{
    const init={method,signal:ctl.signal,headers:{accept:"application/json"}};
    if(body!==undefined){init.headers["content-type"]="application/json";init.body=JSON.stringify(body)}
    const res=await fetch(RESPONDER+path,init);
    const data=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(data.message||data.error||data.code||("HTTP "+res.status));
    return data;
  }finally{clearTimeout(timer)}
};
const tokenType=t=>/^emem:bundle:sha256:[0-9a-f]{40}$/i.test(t)?"legacy":/^emem:bundle:[a-z2-7]+$/i.test(t)?"bundle":/^emem:fact:[^:]+:[a-z2-7]+$/i.test(t)?"fact":null;
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
const sha256=async b=>hex(await crypto.subtle.digest("SHA-256",b));
const legacyDigest=async files=>{const hs=[];for(const f of files)hs.push(await sha256(await f.arrayBuffer()));hs.sort();return (await sha256(new TextEncoder().encode(hs.join(""))).slice(0,40))};
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
class EmemApp extends HTMLElement{
 connectedCallback(){this.render();this.bind()}
 render(){this.innerHTML=`<div class="shell">
 <header><button class="brand" data-home>emem</button><nav><a href="https://github.com/Vortx-AI/emem" target="_blank" rel="noopener">github</a><button data-view="check">check an emem</button><button data-view="about">why</button></nav></header>
 <main>
  <section id="home" class="home">
   <h1>The world is shared.<br>Its memory should be too.</h1>
   <p>External memory another machine can resolve to the same signed bytes.</p>
   <div class="surface">
    <label class="drop" id="drop"><input id="file" type="file" multiple><strong>Drop something</strong><span>Inspect locally. Nothing is called emem until emem returns it.</span></label>
    <div class="or">or</div>
    <form id="pasteForm"><input id="paste" placeholder="Paste an emem: token" autocomplete="off"><button>resolve</button></form>
   </div>
   <div id="local" class="local" hidden></div>
  </section>
  <section id="check" class="view" hidden><button class="back" data-home>← back</button><h2>Check an emem.</h2><p>Resolve an address against the public emem responder.</p><form id="checkForm"><input id="checkInput" placeholder="emem:fact:… or emem:bundle:…" autocomplete="off"><button>resolve</button></form><div id="result" class="result" aria-live="polite"></div></section>
  <section id="about" class="view" hidden><button class="back" data-home>← back</button><h2>One address.<br>The same bytes.</h2><p>emem addresses signed memory. Resolution recovers the underlying object. A valid signature proves who attested unchanged bytes. It does not make a claim objectively true.</p></section>
 </main>
 <footer><span>emem</span><span>public responder · no account required for reads</span></footer>
 </div>`}
 bind(){
  this.querySelectorAll("[data-home]").forEach(x=>x.onclick=()=>this.view("home"));
  this.querySelectorAll("[data-view]").forEach(x=>x.onclick=()=>this.view(x.dataset.view));
  $("#checkForm",this).onsubmit=e=>{e.preventDefault();this.resolve($("#checkInput",this).value)};
  $("#pasteForm",this).onsubmit=e=>{e.preventDefault();const v=$("#paste",this).value.trim();if(v.startsWith("emem:")){this.view("check");$("#checkInput",this).value=v;this.resolve(v)}else this.localText(v)};
  const file=$("#file",this),drop=$("#drop",this);file.onchange=()=>this.inspect([...file.files]);
  ["dragenter","dragover"].forEach(n=>drop.addEventListener(n,e=>{e.preventDefault();drop.dataset.over="true"}));
  ["dragleave","drop"].forEach(n=>drop.addEventListener(n,e=>{e.preventDefault();drop.dataset.over="false"}));
  drop.addEventListener("drop",e=>this.inspect([...e.dataTransfer.files]));
 }
 view(id){["home","check","about"].forEach(x=>$("#"+x,this).hidden=x!==id)}
 inspect(files){
  if(!files.length)return;
  const bytes=files.reduce((n,f)=>n+f.size,0),box=$("#local",this);
  box.hidden=false;
  box.innerHTML=`<b>local only</b><strong>${files.length} source${files.length===1?"":"s"} · ${this.size(bytes)}</strong><p>No emem token has been created. This public node requires attestation for writes, so this browser will not fabricate one.</p><div class="filelist">${files.slice(0,6).map(f=>`<span>${esc(f.name)} <small>${this.size(f.size)}</small></span>`).join("")}</div>`;
 }
 localText(v){if(!v)return;const box=$("#local",this);box.hidden=false;box.innerHTML="<b>local only</b><strong>Text received</strong><p>No emem token has been created. Paste an existing emem address to resolve it.</p>"}
 size(n){for(const u of ["B","KB","MB","GB"]){if(n<1024||u==="GB")return (n<10&&u!=="B"?n.toFixed(1):Math.round(n))+" "+u;n/=1024}}
 async resolve(raw){
  const token=raw.trim(),type=tokenType(token),out=$("#result",this);
  if(!type){out.innerHTML="<b>not an emem address</b><p>Expected emem:fact:&lt;cell&gt;:&lt;cid&gt; or emem:bundle:&lt;cid&gt;.</p>";return}
  if(type==="legacy"){this.showLegacy(token);return}
  out.innerHTML="<b>resolving</b><p>Asking the public responder…</p>";
  try{
   let data;
   if(type==="fact")data=await request("/v1/memory_token/resolve",{method:"POST",body:{token}});
   else data=await request("/v1/memory_bundle/"+encodeURIComponent(token));
   const receipt=data.receipt||data.bundle?.receipt||null;
   let verification=null;
   if(receipt){try{verification=await request("/v1/verify_receipt",{method:"POST",body:{receipt}})}catch{}}
   this.showResolved(token,type,data,verification);
  }catch(e){out.innerHTML=`<b>not resolved</b><p>${esc(e.name==="AbortError"?"Responder timed out.":e.message)}</p>`}
 }
 showLegacy(token){
  const out=$("#result",this),expected=token.split(":").pop();
  out.innerHTML=`<b>legacy demo address</b><code>${esc(token)}</code><p>This old prototype address never wrote memory to emem. If you still have the original source file(s), drop them here and this browser can prove whether they produced this address.</p><label class="recover"><input id="recoverFiles" type="file" multiple><span>choose original source(s)</span></label><div id="recoverState"></div>`;
  $("#recoverFiles",this).onchange=async e=>{const files=[...e.target.files],state=$("#recoverState",this);if(!files.length)return;state.textContent="checking locally…";try{const got=await legacyDigest(files);state.innerHTML=got===expected?"<strong>source match ✓</strong><span>These files reproduce the legacy address exactly. They can now be re-emem’d through a real attested write path.</span>":"<strong>not a match</strong><span>These files do not reproduce this legacy address.</span>"}catch(err){state.textContent="could not check: "+err.message}};
 }
 showResolved(token,type,data,verification){
  const out=$("#result",this),fact=data.fact||data.signed_fact||data,receipt=data.receipt||data.bundle?.receipt||{},valid=verification?.valid??verification?.signature_valid;
  const members=data.members?.length??data.facts?.length??data.citations?.length;
  const details=type==="fact"
   ?[`cell · ${fact.cell||receipt.cells?.[0]||token.split(":")[2]}`,fact.band&&`band · ${fact.band}`,fact.value!==undefined&&`value · ${fact.value}${fact.unit?" "+fact.unit:""}`]
   :[members!==undefined&&`members · ${members}`,receipt.cells?.length&&`cells · ${receipt.cells.length}`];
  out.innerHTML=`<b>resolved by emem</b><code>${esc(token)}</code><div class="facts">${details.filter(Boolean).map(x=>`<span>${esc(x)}</span>`).join("")}</div><div class="proof"><strong>${valid===true?"signature checked":receipt.sig_b32?"signed receipt returned":"object returned"}</strong><span>${valid===true?"The responder's receipt passed verification.":valid===false?"Receipt verification failed.":"No independent verification result was returned."}</span></div><div class="actions"><button id="copyToken">copy address</button><a id="chatToken" target="_blank" rel="noopener">use in ChatGPT</a></div>`;
  $("#copyToken",this).onclick=async()=>{try{await navigator.clipboard.writeText(token);$("#copyToken",this).textContent="copied"}catch{$("#copyToken",this).textContent="copy failed"}};const prompt=`Resolve and verify this emem address before reasoning from it: ${token}`;$("#chatToken",this).href="https://chatgpt.com/?q="+encodeURIComponent(prompt)
 }
}
customElements.define("emem-app",EmemApp);
