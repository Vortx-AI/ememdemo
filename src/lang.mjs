// lang.mjs: the eio language. Pure: no browser, no network, so the page and the build tool read emem.eio the same way.
export const compile=src=>{
 const st=[],lines=src.split("\n");
 for(let i=0;i<lines.length;i++){
  const l=lines[i].replace(/\s+$/,"");
  if(!l||l.startsWith("#"))continue;
  const m=l.match(/^(\w+)\s*(.*)$/);if(!m)throw new Error(`line ${i+1}: cannot read "${l}"`);
  let[,verb,arg]=m,body=null;
  if(/(^|\s)<<$/.test(arg)){arg=arg.replace(/\s*<<$/,"");const b=[];while(++i<lines.length&&lines[i].trim()!==">>")b.push(lines[i]);body=b.join("\n")}
  st.push({verb,arg,body,line:i+1});
 }
 const one=v=>st.find(s=>s.verb===v)?.arg??"",all=v=>st.filter(s=>s.verb===v);
 const steps={},flows={},kinds={};
 // a step may carry its verbs, "| doing done", which is how the page and agents name what is happening
 for(const s of all("step")){const m=s.arg.match(/^(\w+)\s*:\s*(\w+)\s*->\s*(\w+)(?:\s*\|\s*(\S+)\s+(\S+))?$/);if(!m)throw new Error(`line ${s.line}: step needs "name : A -> B" or "name : A -> B | doing done"`);steps[m[1]]={in:m[2],out:m[3],doing:m[4]||m[1],done:m[5]||m[1]}}
 for(const s of all("flow")){const m=s.arg.match(/^(\w+)\s*:\s*(.+)$/);if(!m)throw new Error(`line ${s.line}: flow needs "name : a b c"`);flows[m[1]]=m[2].split(/\s+/)}
 for(const s of all("kind")){const m=s.arg.match(/^(\w+)\s*:\s*(.+)$/);if(!m)throw new Error(`line ${s.line}: kind needs "name : ext ext"`);for(const e of m[2].split(/\s+/))kinds[e]=m[1]}
 // a token row: name : what it is | how to read it over HTTP | the MCP tool that resolves it
 const tokens={};
 for(const s of all("token")){const m=s.arg.match(/^(\w+)\s*:\s*([^|]+)\|\s*([^|]+)\|\s*(\S+)\s*$/);if(!m)throw new Error(`line ${s.line}: token needs "name : meaning | METHOD path | mcp_tool"`);
  const call=m[3].trim().match(/^(GET|POST)\s+(\S+)\s*(.*)$/);if(!call)throw new Error(`line ${s.line}: token call must be "GET path" or "POST path {json}"`);
  tokens[m[1]]={what:m[2].trim(),method:call[1],path:call[2],body:call[3]||null,tool:m[4]}}
 // a gallery entry: kind : title, then "field value" lines
 const shows=all("show").map(s=>{const m=s.arg.match(/^(\w+)\s*:\s*(.+)$/);if(!m||!s.body)throw new Error(`line ${s.line}: show needs "kind : title <<" and fields`);
  return{kind:m[1],title:m[2],...Object.fromEntries(s.body.split("\n").map(l=>l.trim()).filter(Boolean).map(l=>{const i=l.search(/\s/);return i<0?[l,""]:[l.slice(0,i),l.slice(i).trim()]}))}});
 // a language is a second set of the visitor-facing lines, "lang es << say … >>", held to the same rules
 const langs=Object.fromEntries(all("lang").map(l=>[l.arg.trim(),compile(l.body||"")]));
 return{one,all,steps,flows,kinds,tokens,shows,langs};
};

