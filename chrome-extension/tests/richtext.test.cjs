const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
// jsdom comes from the DSH checkout the Host tests already use; skip cleanly when it is absent.
const checkout=process.env.DSH_CHECKOUT||path.join(require('node:os').homedir(),'.dsh/source/staging-20261017T082744Z');
let JSDOM;try{({JSDOM}=require(path.join(checkout,'node_modules/jsdom')));}catch{JSDOM=null;}
const {Kernel}=require('../src/edit-core.js');
const skip=!JSDOM&&'jsdom unavailable (set DSH_CHECKOUT)';
/**
 * jsdom has no editing commands, clipboard events or isContentEditable. These are the smallest
 * stand-ins that behave like a browser for the paths under test; editors with their own paste
 * handling are simulated by a paste listener that calls preventDefault.
 */
function rig(html,{paste}={}){
 const dom=new JSDOM('<!doctype html><title>T</title><body>'+html+'</body>',{pretendToBeVisual:true,url:'https://ex.test/doc'});
 const w=dom.window,doc=w.document;
 Object.defineProperty(w.HTMLElement.prototype,'isContentEditable',{configurable:true,get(){const c=this.closest('[contenteditable]');return !!c&&c.getAttribute('contenteditable')!=='false';}});
 w.DataTransfer=class{constructor(){this.data={};this.files=[];this.items={add:f=>this.files.push(f)};}setData(k,v){this.data[k]=v;}getData(k){return this.data[k]||'';}};
 w.ClipboardEvent=class extends w.Event{constructor(t,o={}){super(t,o);this.clipboardData=o.clipboardData;}};
 const calls=[],state={bold:false};
 doc.queryCommandState=c=>c==='bold'?state.bold:false;
 doc.execCommand=(cmd,_ui,value)=>{
  calls.push(cmd);const sel=w.getSelection(),r=sel.getRangeAt(0);
  if(cmd==='insertText'){r.deleteContents();r.insertNode(doc.createTextNode(value));return true;}
  if(cmd==='insertHTML'){const t=doc.createElement('template');t.innerHTML=value;const blocks=[...t.content.children].filter(e=>e.textContent);const host=(r.startContainer.nodeType===1?r.startContainer:r.startContainer.parentElement).closest('p');let at=host;for(const b of blocks){at.after(b);at=b;}return true;}
  if(cmd==='delete'){const host=(r.startContainer.nodeType===1?r.startContainer:r.startContainer.parentElement).closest('p');r.deleteContents();if(host&&!host.textContent)host.remove();return true;}
  if(cmd==='bold'){const b=doc.createElement('b');b.appendChild(r.extractContents());r.insertNode(b);state.bold=!state.bold;return true;}
  return true;// createLink and the rest: accepted, no effect - verification must catch that
 };
 if(paste)doc.addEventListener('paste',e=>paste(e,doc),true);
 const location={href:'https://ex.test/doc',hostname:'ex.test'};let n=0;
 const kernel=new Kernel({document:doc,location,documentId:'doc',id:()=>String(++n),bridge:async()=>({ok:false,code:'NO_BRIDGE'}),fetchImage:rig.fetchImage});
 const page={version:2,taskId:'task',documentId:'doc',selectionId:'s',url:location.href,token:'x'.repeat(24)};
 const select=(node,a,b)=>{const r=doc.createRange();r.setStart(node.firstChild,a);r.setEnd(node.firstChild,b);w.getSelection().removeAllRanges();w.getSelection().addRange(r);return r;};
 const begin=async(node,a,b)=>{const range=select(node,a,b);return kernel.begin(page,{kind:'range',range,editor:node.closest('[contenteditable]')||node});};
 return {w,doc,kernel,calls,begin};
}
// ProseMirror-like: take the pasted blocks, drop the empty one that merges into the caret block.
const blockPaste=(e,doc)=>{e.preventDefault();const t=doc.createElement('template');t.innerHTML=e.clipboardData.getData('text/html');const sel=doc.defaultView.getSelection(),r=sel.getRangeAt(0);let at=(r.startContainer.nodeType===1?r.startContainer:r.startContainer.parentElement).closest('p,li,h1,h2,h3');for(const b of [...t.content.children].filter(x=>x.textContent)){at.after(b);at=b;}};
const editor='<div id=ed contenteditable="true"><p id=a>one <b>bold</b></p><p id=b>two words</p><p id=c>three</p></div>';
const edit=(k,ref,rev,operation)=>k.edit({targetRef:ref,expectedRevision:rev,operation});

test('generic editor: target carries runs and the full capability set',{skip},async()=>{
 const {doc,begin}=rig(editor);const r=await begin(doc.getElementById('a'),0,3);
 assert.equal(r.ok,true);
 assert.deepEqual(r.target.capabilities.contentTypes,['plain','markdown','html']);
 assert.ok(r.target.capabilities.operations.includes('insert-after'));
 assert.ok(r.target.capabilities.scopes.includes('outline'));
 assert.deepEqual(r.target.runs.map(x=>[x.text,!!x.marks.bold]),[['one ',false],['bold',true]]);
});
test('generic editor: outline lists writable block refs, keyword filters them',{skip},async()=>{
 const {doc,kernel,begin}=rig(editor);await begin(doc.getElementById('a'),0,3);
 const o=await kernel.read({scope:'outline'});assert.equal(o.ok,true);assert.equal(o.targets.length,3);
 assert.deepEqual(o.targets.map(t=>t.text),['one bold','two words','three']);
 const k=await kernel.read({scope:'keyword',find:'WORDS'});assert.equal(k.targets.length,1);assert.equal('kind' in k.targets[0],false);assert.equal(k.targets[0].blockType!==undefined,true);
 const rg=await kernel.read({scope:'range',at:o.targets[1].targetRef});assert.equal(rg.targets.length,2);
});
test('insert-after adds new blocks through the editor paste and leaves the block itself alone',{skip},async()=>{
 const {doc,kernel,begin}=rig(editor,{paste:blockPaste});await begin(doc.getElementById('a'),0,3);
 const b=(await kernel.read({scope:'outline'})).targets[1];
 const v=await edit(kernel,b.targetRef,b.revision,{type:'insert-after',text:'NEW',contentType:'markdown'});
 assert.equal(v.ok,true,JSON.stringify(v));
 assert.deepEqual([...doc.querySelectorAll('#ed p')].map(p=>p.textContent),['one bold','two words','NEW','three']);
});
test('insert-after falls back to the native command when no editor handles paste',{skip},async()=>{
 const {doc,kernel,calls,begin}=rig(editor);await begin(doc.getElementById('a'),0,3);
 const b=(await kernel.read({scope:'outline'})).targets[0];
 const v=await edit(kernel,b.targetRef,b.revision,{type:'insert-after',text:'line 1\nline 2'});
 assert.equal(v.ok,true,JSON.stringify(v));assert.ok(calls.includes('insertHTML'));
 assert.deepEqual([...doc.querySelectorAll('#ed p')].map(p=>p.textContent),['one bold','line 1','line 2','two words','three']);
});
test('a multi-line replacement is verified against what the editor shows',{skip},async()=>{
 const {doc,kernel,begin}=rig(editor,{paste:(e,d)=>{e.preventDefault();/* editor ignores it */}});await begin(doc.getElementById('a'),0,3);
 const b=(await kernel.read({scope:'outline'})).targets[2];
 const v=await edit(kernel,b.targetRef,b.revision,{type:'replace-block',text:'# Title\n- x',contentType:'markdown'});
 assert.equal(v.ok,false);assert.equal(v.code,'NOT_APPLIED');assert.equal(v.modification,'not-modified');
});
test('delete-block removes exactly that block',{skip},async()=>{
 const {doc,kernel,begin}=rig(editor);await begin(doc.getElementById('a'),0,3);
 const b=(await kernel.read({scope:'outline'})).targets[1];
 const v=await edit(kernel,b.targetRef,b.revision,{type:'delete-block'});
 assert.equal(v.ok,true,JSON.stringify(v));
 assert.deepEqual([...doc.querySelectorAll('#ed p')].map(p=>p.textContent),['one bold','three']);
});
test('delete-block and insert-before refuse a range ref',{skip},async()=>{
 const {doc,kernel,begin}=rig(editor);const r=await begin(doc.getElementById('b'),0,3);
 assert.equal((await edit(kernel,r.targetRef,r.target.revision,{type:'delete-block'})).code,'SCOPE_MISMATCH');
 assert.equal((await edit(kernel,r.targetRef,r.target.revision,{type:'insert-before',text:'x'})).code,'SCOPE_MISMATCH');
 assert.equal(doc.getElementById('b').textContent,'two words');
});
test('set-format bold is applied and read back from runs',{skip},async()=>{
 const {doc,kernel,begin}=rig(editor);const r=await begin(doc.getElementById('b'),4,9);
 const v=await edit(kernel,r.targetRef,r.target.revision,{type:'set-format',format:{bold:true}});
 assert.equal(v.ok,true,JSON.stringify(v));assert.equal(doc.querySelector('#b b').textContent,'words');
});
test('a link the editor ignored is reported as not applied',{skip},async()=>{
 const {doc,kernel,begin}=rig(editor);const r=await begin(doc.getElementById('b'),0,3);
 const v=await edit(kernel,r.targetRef,r.target.revision,{type:'set-format',format:{link:'https://ex.test/x'}});
 assert.equal(v.ok,false);assert.equal(v.code,'POSTCONDITION_FAILED');assert.deepEqual(v.failedFormats,['link']);
});
test('unsafe link and html never pass',{skip},async()=>{
 const {doc,kernel,begin}=rig(editor,{paste:blockPaste});const r=await begin(doc.getElementById('a'),0,3);
 assert.equal((await edit(kernel,r.targetRef,r.target.revision,{type:'set-format',format:{link:'javascript:alert(1)'}})).code,'INVALID_FORMAT');
 const b=(await kernel.read({scope:'outline'})).targets[0];
 const v=await edit(kernel,b.targetRef,b.revision,{type:'insert-after',text:'<p onclick="x()">safe<script>bad()</script></p>',contentType:'html'});
 assert.equal(v.ok,true,JSON.stringify(v));
 const added=doc.querySelectorAll('#ed p')[1];assert.equal(added.textContent,'safe');assert.equal(added.getAttribute('onclick'),null);assert.equal(doc.querySelector('#ed script'),null);
});
test('insert-image pastes the fetched file and checks an image appeared',{skip},async()=>{
 rig.fetchImage=async()=>({ok:true,type:'image/png',name:'x.png',bytes:new Uint8Array([137,80,78,71])});
 const {doc,kernel,begin}=rig(editor,{paste:(e,d)=>{const f=e.clipboardData.files[0];if(!f)return;e.preventDefault();const img=d.createElement('img');img.alt=f.name;img.src='blob:uploaded';d.getElementById('a').after(img);const sep=d.createElement('img');sep.className='ProseMirror-separator';d.getElementById('a').append(sep);}});
 rig.fetchImage=undefined;
 await begin(doc.getElementById('a'),0,3);
 const b=(await kernel.read({scope:'outline'})).targets[0];
 const v=await edit(kernel,b.targetRef,b.revision,{type:'insert-image',image:{src:'https://img.test/x.png'}});
 assert.equal(v.ok,true,JSON.stringify(v));assert.equal(doc.querySelectorAll('#ed img[src]').length,1);
});
test('insert-image without an image source path fails before touching the page',{skip},async()=>{
 const {doc,kernel,begin}=rig(editor);await begin(doc.getElementById('a'),0,3);
 const b=(await kernel.read({scope:'outline'})).targets[0],html=doc.getElementById('ed').innerHTML;
 const v=await edit(kernel,b.targetRef,b.revision,{type:'insert-image',image:{src:'https://img.test/x.png'}});
 assert.equal(v.code,'ADAPTER_UNAVAILABLE');assert.equal(doc.getElementById('ed').innerHTML,html);
});
test('read-only page text binds the task: document reads work, outline does not pretend',{skip},async()=>{
 const {doc,kernel,begin}=rig('<main><h1>Article</h1><p id=t>static text here</p><a href="/next">Next</a><img src="/i.png" alt="pic"></main>');
 const r=await begin(doc.getElementById('t'),0,6);
 assert.equal(r.ok,false);assert.equal(r.code,'READ_ONLY');assert.equal(r.bound,true);
 const d=await kernel.read({scope:'document'});assert.equal(d.ok,true);
 assert.equal(d.page.title,'T');
 assert.deepEqual(d.items.map(i=>i.type),['heading','paragraph','paragraph','image']);
 assert.equal(d.items[2].links[0].href,'https://ex.test/next');
 assert.equal('targetRef' in d.items[0],false);
 assert.equal((await kernel.read({scope:'outline'})).code,'UNSUPPORTED_OPERATION');
 assert.equal((await kernel.read({scope:'document',at:'x'})).code,'INVALID_ARGUMENT');
});
test('document reads page with a cursor and refuse a stale one',{skip},async()=>{
 const {doc,kernel,begin}=rig('<main>'+Array.from({length:30},(_,i)=>'<p>item '+i+'</p>').join('')+'</main><p id=t>x</p>');
 await begin(doc.getElementById('t'),0,1);
 const first=await kernel.read({scope:'document',limit:10});assert.equal(first.returned,10);assert.ok(first.cursor);
 const next=await kernel.read({scope:'document',limit:10,cursor:first.cursor});assert.equal(next.items[0].text,'item 10');
 doc.querySelector('main').insertAdjacentHTML('afterbegin','<p>new first</p>');
 assert.equal((await kernel.read({scope:'document',cursor:first.cursor})).code,'STALE_CURSOR');
});

test('CodeMirror 6: offsets come from the editor model and writes go through dispatch',{skip},async()=>{
 const dom=new JSDOM('<!doctype html><body><div class="cm-editor"><div class="cm-content" contenteditable="true"><div class="cm-line">const a = 1;</div></div></div></body>',{url:'https://ex.test/code',runScripts:'outside-only'});
 const w=dom.window,doc=w.document;
 Object.defineProperty(w.HTMLElement.prototype,'isContentEditable',{configurable:true,get(){const c=this.closest('[contenteditable]');return !!c&&c.getAttribute('contenteditable')!=='false';}});
 // A CodeMirror view as the page owns it: model text, a model selection, and dispatch.
 let text='const a = 1;\nconst b = 2;';const view={state:{get doc(){return {toString:()=>text};},selection:{main:{from:6,to:7}}},contentDOM:doc.querySelector('.cm-content'),dispatch({changes}){text=text.slice(0,changes.from)+changes.insert+text.slice(changes.to);}};
 doc.querySelector('.cm-content').cmView={view};
 w.eval(require('node:fs').readFileSync(require.resolve('../src/code-engine.js'),'utf8'));
 const location={href:'https://ex.test/code',hostname:'ex.test'};let n=0;
 const kernel=new Kernel({document:doc,location,documentId:'doc',id:()=>'id'+(++n),bridge:async spec=>{assert.equal(spec.engine,'code');return w.DSHCodeV1.run(spec);}});
 const page={version:2,taskId:'task',documentId:'doc',selectionId:'s',url:location.href,token:'x'.repeat(24)};
 const line=doc.querySelector('.cm-line'),range=doc.createRange();range.setStart(line.firstChild,6);range.setEnd(line.firstChild,7);
 const r=await kernel.begin(page,{kind:'range',range,editor:doc.querySelector('.cm-content'),text:'a'});
 assert.equal(r.ok,true,JSON.stringify(r));assert.equal('adapter' in r.target,false);assert.equal(r.target.text,'a');
 const v=await kernel.edit({targetRef:r.targetRef,expectedRevision:r.target.revision,operation:{type:'replace-selection',text:'answer'}});
 assert.equal(v.ok,true,JSON.stringify(v));assert.equal(text,'const answer = 1;\nconst b = 2;');
 text+='\n// someone typed';
 const stale=await kernel.edit({targetRef:v.targetRef,expectedRevision:v.target.revision,operation:{type:'replace-selection',text:'x'}});
 assert.equal(stale.code,'REVISION_CONFLICT');assert.equal(text,'const answer = 1;\nconst b = 2;\n// someone typed');
});
