/* Markup helpers shared by DOM adapters: markdown/plain -> safe HTML, sanitizing, and formatting runs. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else Object.defineProperty(root,'DSHMarkup',{value:api,configurable:true});})(globalThis,function(){
'use strict';
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const SAFE_URL=/^(https?:|mailto:)/i;
function inline(text){
 // Code spans first so their contents are not parsed as emphasis or links.
 const codes=[];let s=String(text).replace(/\x60([^\x60]+)\x60/g,(_,c)=>{codes.push(c);return '\u0000'+(codes.length-1)+'\u0000';});
 s=esc(s);
 s=s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,(m,label,url)=>SAFE_URL.test(url.replace(/&amp;/g,'&'))?'<a href="'+url+'">'+label+'</a>':label);
 s=s.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/__([^_]+)__/g,'<strong>$1</strong>');
 s=s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g,'$1<em>$2</em>').replace(/~~([^~]+)~~/g,'<s>$1</s>');
 return s.replace(/\u0000(\d+)\u0000/g,(_,i)=>'<code>'+esc(codes[Number(i)])+'</code>');
}
/** A small, predictable markdown subset: headings, lists, quotes, fences, paragraphs, inline marks, links. */
function markdownToHtml(md){
 const lines=String(md).replace(/\r\n?/g,'\n').split('\n'),out=[];let list=null,para=[],fence=null;
 const flush=()=>{if(para.length){out.push('<p>'+para.map(inline).join('<br>')+'</p>');para=[];}};
 const close=()=>{if(list){out.push('</'+list+'>');list=null;}};
 for(const line of lines){
  if(fence!==null){if(/^\x60\x60\x60/.test(line)){out.push('<pre><code>'+esc(fence.join('\n'))+'</code></pre>');fence=null;}else fence.push(line);continue;}
  if(/^\x60\x60\x60/.test(line)){flush();close();fence=[];continue;}
  const h=/^(#{1,6})\s+(.*)$/.exec(line),ul=/^\s*[-*+]\s+(.*)$/.exec(line),ol=/^\s*\d+[.)]\s+(.*)$/.exec(line),q=/^>\s?(.*)$/.exec(line);
  if(h){flush();close();out.push('<h'+h[1].length+'>'+inline(h[2])+'</h'+h[1].length+'>');continue;}
  if(ul||ol){flush();const want=ul?'ul':'ol';if(list!==want){close();out.push('<'+want+'>');list=want;}out.push('<li>'+inline((ul||ol)[1])+'</li>');continue;}
  if(q){flush();close();out.push('<blockquote><p>'+inline(q[1])+'</p></blockquote>');continue;}
  if(!line.trim()){flush();close();continue;}
  close();para.push(line);
 }
 if(fence!==null)out.push('<pre><code>'+esc(fence.join('\n'))+'</code></pre>');
 flush();close();return out.join('');
}
/** Plain text keeps every character; line breaks become paragraphs so an editor sees real blocks. */
function plainToHtml(text){return String(text).replace(/\r\n?/g,'\n').split('\n').map(l=>'<p>'+(l?esc(l):'<br>')+'</p>').join('');}
const ALLOWED=new Set(['P','BR','STRONG','B','EM','I','U','S','DEL','STRIKE','CODE','PRE','A','UL','OL','LI','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','IMG','SPAN','DIV']);
/** Reduce arbitrary HTML to a fixed vocabulary; scripts, handlers, styles and unsafe URLs never pass. */
function sanitize(html,doc){
 const t=doc.createElement('template');t.innerHTML=String(html);
 const walk=node=>{for(const child of [...node.childNodes]){
  if(child.nodeType===3)continue;
  if(child.nodeType!==1){child.remove();continue;}
  if(!ALLOWED.has(child.tagName)){
   if(/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|TEMPLATE|NOSCRIPT|SVG|MATH)$/.test(child.tagName)){child.remove();continue;}
   walk(child);child.replaceWith(...child.childNodes);continue;
  }
  for(const a of [...child.attributes]){
   const keep=(child.tagName==='A'&&a.name==='href'&&SAFE_URL.test(a.value))||(child.tagName==='IMG'&&a.name==='src'&&/^(https?:|data:image\/)/i.test(a.value))||(child.tagName==='IMG'&&a.name==='alt');
   if(!keep)child.removeAttribute(a.name);
  }
  walk(child);
 }};
 walk(t.content);return t.innerHTML;
}
/** The text an HTML fragment will contribute, whitespace-collapsed for tolerant comparison. */
function htmlText(html,doc){const t=doc.createElement('template');t.innerHTML=String(html);return t.content.textContent||'';}
const squash=s=>String(s).replace(/[\u200b\u200c\u200d\ufeff\u00a0]/g,'').replace(/\s+/g,'');
const MARK_TAGS={STRONG:'bold',B:'bold',EM:'italic',I:'italic',U:'underline',S:'strikethrough',DEL:'strikethrough',STRIKE:'strikethrough',CODE:'code'};
function marksOf(node,root){
 const m={};
 for(let el=node.parentElement;el&&el!==root.parentElement;el=el.parentElement){
  const k=MARK_TAGS[el.tagName];if(k)m[k]=true;
  if(el.tagName==='A'&&el.getAttribute('href')&&m.link===undefined)m.link=el.getAttribute('href');
  const st=el.style;if(st){
   if(/^(bold|[6-9]00)$/.test(st.fontWeight))m.bold=true;
   if(st.fontStyle==='italic')m.italic=true;
   const deco=String(st.textDecoration||st.textDecorationLine||'');
   if(/underline/.test(deco))m.underline=true;if(/line-through/.test(deco))m.strikethrough=true;
   if(st.color&&m.color===undefined)m.color=st.color;
   if(st.backgroundColor&&m.highlight===undefined)m.highlight=st.backgroundColor;
  }
  if(el===root)break;
 }
 return m;
}
/** Formatting runs over root's text, in the same offsets as root.textContent. */
function runs(root,doc,max=200){
 const w=doc.createTreeWalker(root,4),out=[];let n,pos=0;
 while((n=w.nextNode())){
  const text=n.data;if(!text)continue;const marks=marksOf(n,root),key=JSON.stringify(marks),last=out[out.length-1];
  if(last&&last.key===key&&last.end===pos){last.end+=text.length;last.text+=text;}
  else{if(out.length>=max){out.truncated=true;break;}out.push({start:pos,end:pos+text.length,text,marks,key});}
  pos+=text.length;
 }
 const res=out.map(({key,...r})=>r);if(out.truncated)res.truncated=true;return res;
}
return {markdownToHtml,plainToHtml,sanitize,htmlText,squash,runs,inline};
});
