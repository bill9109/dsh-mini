/* Read-only page reader: the visible document as a bounded list. It issues no refs and never writes. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else Object.defineProperty(root,'DSHPageDocument',{value:api,configurable:true});})(globalThis,function(){
'use strict';
const SKIP=new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','CANVAS','IFRAME','OBJECT','EMBED','HEAD','META','LINK']);
const BLOCK='p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,table,ul,ol,dl,dt,dd,figure,figcaption,section,article,main,aside,nav,header,footer,form,fieldset,div,img,input,textarea,select,button';
const HEADING=/^H([1-6])$/;
const MAX_TEXT=2000,MAX_LINKS=12,MAX_ELEMENTS=8000,MAX_CHARS=60000;
const clean=s=>String(s==null?'':s).replace(/[\u200b\u200c\u200d\ufeff]/g,'').replace(/\s+/g,' ').trim();
const cut=(s,n)=>s.length>n?s.slice(0,n)+'…':s;
function hidden(el,view){
 if(el.hidden||el.getAttribute('aria-hidden')==='true')return true;
 if(el.id==='dsh-mini-panel')return true;
 try{const cs=view&&view.getComputedStyle?view.getComputedStyle(el):null;if(cs&&(cs.display==='none'||cs.visibility==='hidden'))return true;}catch(e){}
 return false;
}
function editableOf(el){
 if(/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))return !el.disabled&&!el.readOnly;
 if(el.isContentEditable===true)return true;
 const ce=el.closest&&el.closest('[contenteditable]');return !!(ce&&ce.getAttribute('contenteditable')!=='false');
}
function region(el){const r=el.closest&&el.closest('nav,header,footer,aside,main,[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=main]');if(!r)return undefined;const role=r.getAttribute('role');return role?({navigation:'nav',banner:'header',contentinfo:'footer',complementary:'aside',main:'main'})[role]||role:r.tagName.toLowerCase();}
function abs(u,base){try{const x=new URL(u,base);return /^(https?|mailto):$/.test(x.protocol)?cut(x.href,500):undefined;}catch(e){return undefined;}}
function links(el,base){const out=[];const all=el.tagName==='A'?[el]:[...el.querySelectorAll('a[href]')];for(const a of all){const href=abs(a.getAttribute('href'),base);if(!href)continue;out.push({text:cut(clean(a.textContent),120),href});if(out.length>=MAX_LINKS)break;}return out;}
function labelOf(el,doc){
 const aria=el.getAttribute('aria-label');if(aria)return clean(aria);
 if(el.id){try{const l=doc.querySelector('label[for="'+String(el.id).replace(/"/g,'\\"')+'"]');if(l)return clean(l.textContent);}catch(e){}}
 const wrap=el.closest('label');if(wrap)return clean(wrap.textContent);
 return clean(el.getAttribute('placeholder')||el.getAttribute('name')||el.getAttribute('title')||'');
}
function field(el,doc){
 const tag=el.tagName.toLowerCase(),type=tag==='input'?(el.type||'text').toLowerCase():tag;
 if(type==='hidden')return null;
 const item={type:'field',fieldType:type,label:cut(labelOf(el,doc),200),editable:editableOf(el)};
 if(type==='password')item.value='(hidden)';
 else if(type==='checkbox'||type==='radio')item.checked=!!el.checked;
 else if(tag==='select'){const o=el.options&&el.options[el.selectedIndex];item.value=o?cut(clean(o.textContent),200):'';item.options=[...(el.options||[])].slice(0,20).map(o=>cut(clean(o.textContent),80));}
 else if(tag==='button'||type==='submit'||type==='button'){item.type='button';item.text=cut(clean(el.textContent||el.value),200);delete item.fieldType;delete item.editable;}
 else item.value=cut(String(el.value||''),500);
 return item;
}
function table(el){const rows=[];for(const tr of [...el.querySelectorAll('tr')].slice(0,30)){rows.push([...tr.children].slice(0,10).map(c=>cut(clean(c.textContent),200)));}return {type:'table',rows,rowCount:el.querySelectorAll('tr').length};}
/**
 * Walk the visible page in document order and return typed items. A leaf block (no block-level
 * descendants) becomes one item; containers are descended into. Text inside nested blocks is never
 * counted twice.
 */
function collect(doc,{base}={}){
 const view=doc.defaultView,items=[],els=[];let seen=0,truncated=false;
 // els runs parallel to items: the element behind each item, so an image can be found again by index.
 const push=(item,el)=>{if(item.text!==undefined&&!item.text&&item.type!=='image')return;items.push(item);els.push(el||null);};
 const visit=el=>{
  if(++seen>MAX_ELEMENTS){truncated=true;return;}
  if(SKIP.has(el.tagName)||hidden(el,view))return;
  const tag=el.tagName;
  if(tag==='IMG'){const src=abs(el.getAttribute('src')||'',base);push({type:'image',alt:cut(clean(el.getAttribute('alt')||''),300),src,width:el.naturalWidth||el.width||undefined,height:el.naturalHeight||el.height||undefined,region:region(el)},el);return;}
  if(/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tag)){const f=field(el,doc);if(f){f.region=region(el);push(f);}return;}
  if(tag==='TABLE'){const t=table(el);t.region=region(el);items.push(t);els.push(null);return;}
  const h=HEADING.exec(tag);
  const nested=el.querySelector(BLOCK);
  if(!nested||h||tag==='PRE'||tag==='LI'&&!el.querySelector('li,ul,ol,p,div,table')){
   const text=cut(clean(el.textContent),MAX_TEXT);
   const type=h?'heading':tag==='LI'?'list-item':tag==='BLOCKQUOTE'?'quote':tag==='PRE'?'code':'paragraph';
   const item={type,text};if(h)item.level=Number(h[1]);
   const ls=links(el,base);if(ls.length)item.links=ls;
   if(editableOf(el))item.editable=true;const rg=region(el);if(rg)item.region=rg;
   push(item);
   if(!h&&tag!=='PRE')for(const img of el.querySelectorAll('img'))visit(img);
   return;
  }
  // Container: text sitting directly in it (not in a child element) is still content.
  for(const child of el.childNodes){
   if(child.nodeType===3){const text=cut(clean(child.data),MAX_TEXT);if(text)push({type:'paragraph',text,...(editableOf(el)?{editable:true}:{}),...(region(el)?{region:region(el)}:{})});}
   else if(child.nodeType===1)visit(child);
   if(truncated)return;
  }
 };
 if(doc.body)visit(doc.body);
 return {items,truncated,els};
}
/** The element of the image item at index (the "i" scope document reports), or a reason it cannot be used. */
function imageAt(doc,location,index){
  const {items,els}=collect(doc,{base:location.href});
  const item=items[index];
  if(!item)return {error:'NO_IMAGE',message:'The page has no item '+index+' (it has '+items.length+'); read scope document again.'};
  if(item.type!=='image'||!els[index])return {error:'NO_IMAGE',message:'Item '+index+' is a '+item.type+', not an image; read scope document again for the current indexes.'};
  return {el:els[index],item};
}
const hashOf=s=>{let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(36);};
/** One bounded, paged, read-only view of the page. */
function read(doc,location,{find,limit=100,cursor}={}){
 const {items,truncated}=collect(doc,{base:location.href});
 const fingerprint=hashOf(location.href+'|'+items.length+'|'+items.slice(0,40).map(i=>i.text||i.alt||i.label||'').join('|'));
 let start=0;
 if(cursor!==undefined){const m=/^doc:([a-z0-9]+):(\d+)$/.exec(cursor);if(!m||m[1]!==fingerprint)return {ok:false,code:'STALE_CURSOR',message:'The page changed since this cursor was issued; read again without cursor.'};start=Number(m[2]);}
 const needle=find?String(find).toLowerCase():null;
 const indexed=items.map((item,i)=>({i,...item}));
 const pool=needle?indexed.filter(x=>[x.text,x.alt,x.label,x.value,...(x.rows||[]).flat()].some(v=>typeof v==='string'&&v.toLowerCase().includes(needle))):indexed;
 const out=[];let chars=0,n=start;
 for(;n<pool.length&&out.length<limit;n++){const size=JSON.stringify(pool[n]).length;if(out.length&&chars+size>MAX_CHARS)break;chars+=size;out.push(pool[n]);}
 const sel=(()=>{try{const s=doc.defaultView.getSelection();return s&&s.rangeCount?cut(clean(s.toString()),500):'';}catch(e){return '';}})();
 return {ok:true,code:'READ',modification:'not-modified',verification:'dom-observed',retryable:false,scope:'document',
  page:{title:cut(clean(doc.title),300),url:location.href,lang:doc.documentElement&&doc.documentElement.getAttribute('lang')||undefined,selection:sel||undefined},
  total:pool.length,returned:out.length,truncated:n<pool.length||truncated,...(n<pool.length?{cursor:'doc:'+fingerprint+':'+n}:{}),items:out,
  context:{note:'Read-only view of the visible page in document order. These items carry NO refs and cannot be written. To edit, use the bound target, or outline/range/keyword where the adapter supports them. Navigation, clicks and form filling are for the browser tools (webbridge_*), not page_edit.'}};
}
const IMG_EDGE=1568,IMG_B64_MAX=150000,IMG_TRIES=[[1,0.82],[1,0.68],[0.75,0.68],[0.6,0.6],[0.45,0.55],[0.33,0.5]];
/**
 * Encode the pixels of one on-page image as a bounded JPEG. The page's own login state does the
 * authorizing: the element is drawn as the page already loaded it, and only when that taints the
 * canvas is it fetched again with the page's credentials (same rules as the page's own scripts).
 * Nothing is sent to a third party; the result is base64 for the Host to store as an attachment.
 */
async function capture(doc,el,fetchPublic){
  const view=doc.defaultView,fault=(code,message)=>({ok:false,code,message});
  if(!el||el.tagName!=='IMG')return fault('NO_IMAGE','That item is not an image element.');
  if(!el.complete||!el.naturalWidth)return fault('IMAGE_NOT_LOADED','The image has not loaded (scroll it into view and read again).');
  const W=el.naturalWidth,H=el.naturalHeight;
  const draw=async(source,w,h)=>{
    const out=[];
    for(const [k,q] of IMG_TRIES){
      const edge=Math.min(1,IMG_EDGE/Math.max(w,h))*k,cw=Math.max(1,Math.round(w*edge)),ch=Math.max(1,Math.round(h*edge));
      const c=doc.createElement('canvas');c.width=cw;c.height=ch;const x=c.getContext('2d');
      x.fillStyle='#fff';x.fillRect(0,0,cw,ch);x.drawImage(source,0,0,cw,ch);
      const url=c.toDataURL('image/jpeg',q);const b64=url.slice(url.indexOf(',')+1);
      out.push({width:cw,height:ch,base64:b64});if(b64.length<=IMG_B64_MAX)return out[out.length-1];
    }
    return null;
  };
  let hit=null,tainted=false;
  try{hit=await draw(el,W,H);}catch(e){tainted=/security|tainted/i.test(String(e&&(e.name+e.message)));if(!tainted)return fault('IMAGE_UNREADABLE',String(e&&e.message||e).slice(0,120));}
  if(tainted){
    const src=el.currentSrc||el.src;
    let blob=null,why='';
    // 1) The page's own request, with the page's own login state - the same thing its scripts can do.
    try{const res=await view.fetch(src,{credentials:'include'});if(res.ok)blob=await res.blob();else why='HTTP '+res.status;}catch(e){why=String(e&&e.message||e).slice(0,80);}
    // 2) A cross-origin image the page may not read: ask the extension for the PUBLIC copy (no cookies,
    // no private addresses). A private or login-only image therefore stays unreadable, by design.
    if(!blob&&typeof fetchPublic==='function'){
      try{
        const got=await fetchPublic(src);
        if(got&&got.ok&&got.bytes)blob=new Blob([got.bytes],{type:got.type});
        else if(got&&got.message)why=got.message;
      }catch(e){why=String(e&&e.message||e).slice(0,80);}
    }
    if(!blob)return fault('IMAGE_UNREADABLE','The page cannot read this image\'s pixels ('+why+'). Only images the page itself can read, or public ones, can be shown.');
    try{const bmp=await view.createImageBitmap(blob);hit=await draw(bmp,bmp.width,bmp.height);}
    catch(e){return fault('IMAGE_UNREADABLE','The image could not be decoded: '+String(e&&e.message||e).slice(0,80));}
  }
  if(!hit)return fault('IMAGE_TOO_LARGE','The image could not be reduced to the size limit.');
  return {ok:true,image:{mediaType:'image/jpeg',base64:hit.base64,width:hit.width,height:hit.height,originalWidth:W,originalHeight:H}};
}
return {read,collect,imageAt,capture};
});
