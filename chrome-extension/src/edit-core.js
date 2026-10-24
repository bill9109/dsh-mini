/* Editing kernel v2: one executor. Targets come from the registry, per-editor behaviour from adapters. */
// Refusals raised BELOW the bridge never reached the bridge's log, which is exactly where most
// failures happened. This ring records them and travels with the outcome back to the Host.
var PANEL_RING = [];
function panelLog(what, detail) {
  try {
    PANEL_RING.push({ t: new Date().toISOString().slice(11, 19), what: String(what), detail: String(detail == null ? '' : detail).slice(0, 160) });
    while (PANEL_RING.length > 200) PANEL_RING.shift();
  } catch (e) {}
}
(function(root,factory){
 const isNode=typeof module==='object'&&module.exports;
 const api=factory(
  isNode?require('./edit-protocol.js'):root.DSHPageProtocol,
  isNode?require('./target-registry.js'):root.DSHTargetRegistry,
  isNode?{input:require('./adapters/input.js'),richtext:require('./adapters/richtext.js'),feishu:require('./adapters/feishu.js')}
        :{input:root.DSHAdapterInput,richtext:root.DSHAdapterRichtext,feishu:root.DSHAdapterFeishu});
 if(isNode)module.exports=api;else Object.defineProperty(root,'DSHPageKernel',{value:api,configurable:true});
})(globalThis,function(P,Registry,adapters){
'use strict';
const fail=P.failure;
const hash=s=>{let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(36);};
const revision=s=>'dom-'+hash(JSON.stringify(s));
class Fault extends Error{constructor(code,message,extra={}){super(message);panelLog(code,String(message).slice(0,80));this.outcome=fail(code,message,extra);if(this.outcome)this.outcome.recent=PANEL_RING.slice(-10);}}
const element=n=>n?.nodeType===1?n:n?.parentElement;
// Zero-width characters and non-breaking spaces are editor plumbing, not user text: the DOM carries
// them and the editor model does not. Comparing them raw rejected every real selection, so both
// sides of a text comparison are normalized first.
const normalize=value=>String(value).replace(/[\u200b\u200c\u200d\ufeff\u00a0]/g,'');
function offsetIn(root,node,offset,doc){const r=doc.createRange();r.selectNodeContents(root);r.setEnd(node,offset);return r.toString().length;}
// Feishu's .ace-line text carries zero-width placeholders the editor MODEL does not have.
// Measuring the DOM directly therefore produced offsets one past the model text (32 vs 31)
// and every selection was rejected as stale. Only the Feishu branch needs this scale.
function modelOffsetIn(root,node,offset,doc){return offsetIn(root,node,offset,doc)-(()=>{const r=doc.createRange();r.selectNodeContents(root);r.setEnd(node,offset);return (r.toString().match(/\u200b/g)||[]).length;})();}
function plainRange(root,start,end,doc){const w=doc.createTreeWalker(root,4);let n,pos=0,a,b;while((n=w.nextNode())){const next=pos+n.data.length;if(!a&&start<=next)a=[n,start-pos];if(end<=next){b=[n,end-pos];break;}pos=next;}const r=doc.createRange();if(!a&&start===0&&end===0){r.selectNodeContents(root);r.collapse(true);return r;}if(!a||!b)throw new Fault('STALE_TARGET','Exact offsets no longer exist');r.setStart(...a);r.setEnd(...b);return r;}
class Kernel{
 constructor({document,location,documentId,bridge,id=()=>globalThis.crypto.randomUUID(),now=()=>Date.now()}){
  this.doc=document;this.location=location;this.documentId=documentId;this.bridge=bridge;this.id=id;this.now=now;
  this.registry=new Registry.TargetRegistry({id,now,fault:(code,message,extra)=>new Fault(code,message,extra)});
  this.completed=new Map();this.inflight=new Map();this.tail=Promise.resolve();this.scope=null;this.contextCell=null;
 }
 get defaultRef(){return this.registry.default;}
 set defaultRef(value){this.registry.default=value;}
 identity(){if(!this.scope)throw new Fault('NO_TARGET','No task is bound');if(this.scope.url!==this.location.href)throw new Fault('PAGE_CHANGED','Document URL changed');return this.scope;}
 issue(desc,snap){return this.registry.issue(this.identity(),desc,snap);}
 resolve(ref){return this.registry.resolve(this.identity(),ref);}
 context(state){return {doc:this.doc,location:this.location,scope:this.scope,bridge:this.bridge,revision,plainRange,validateOutcome:P.validateOutcome,fault:(code,message,extra)=>new Fault(code,message,extra),snapshot:t=>this.snapshot(t),mark:()=>{state.submitted=true;}};}
 adapter(name){const found=adapters[name];if(!found)throw new Fault('ADAPTER_UNAVAILABLE','No adapter for '+name);return found;}
 snapshot(t){return this.adapter(t.adapter).snapshot(this.context({submitted:false}),t);}
 async begin(page,anchor){
    panelLog('kernel/begin/enter', { anchorKind: String(anchor && anchor.kind || '').slice(0, 16), doc: String(this.documentId || '').slice(-6) });
  // begin() returns the same outcome shape as read()/edit(): one kernel, one error contract.
  try{
  if(page.version!==2||page.documentId!==this.documentId||page.url!==this.location.href)throw new Fault('PROTOCOL_MISMATCH','Invalid task/document identity');
  if(this.activeEdit)throw new Fault('BUSY','Previous edit is settling');
  this.scope={...page};this.registry.clear();this.completed.clear();this.inflight.clear();this.contextCell=null;
  let desc;
  if(anchor.kind==='control')desc={adapter:'input',node:anchor.editor,kind:anchor.start===anchor.end?'caret':'range',start:anchor.start,end:anchor.end};
  else{
   const range=anchor.range;if(!range||!range.startContainer.isConnected||!range.endContainer.isConnected)throw new Fault('STALE_TARGET','Selection is detached');
   const start=element(range.startContainer),end=element(range.endContainer),block=start?.closest?.('[data-record-id][data-block-type]');
   const feishu=/(^|\.)(feishu\.cn|larksuite\.com)$/.test(this.location.hostname);
   if(feishu&&block){
    if(end?.closest?.('[data-record-id][data-block-type]')!==block)throw new Fault('CROSS_BLOCK','A selection spanning several blocks is not supported yet');
    // A collapsed caret anywhere inside the block is enough for a whole-block operation. Only a real
    // SELECTION that falls outside the editor's text is refused. Requiring the caret itself to sit in
    // .ace-line rejected empty blocks and structurally unusual ones, which the caller could not act on.
    const line=block.querySelector('.ace-line');
    const insideLine=!!(line&&line.contains(range.startContainer)&&line.contains(range.endContainer));
    const insideBlock=block.contains(range.startContainer)&&block.contains(range.endContainer);
    if(!insideLine&&!(range.collapsed&&insideBlock))throw new Fault('OUTSIDE_EDITOR_TEXT','Put the cursor inside the block you want to change, or select its text');
    desc={adapter:'feishu',recordId:block.getAttribute('data-record-id'),kind:range.collapsed?'caret':'range',start:modelOffsetIn(line,range.startContainer,range.startOffset,this.doc),end:modelOffsetIn(line,range.endContainer,range.endOffset,this.doc)};
    this.contextCell=block.closest('td,th');
   }else{
    const editor=anchor.editor;if(!editor?.isContentEditable||!editor.contains(range.endContainer))throw new Fault('READ_ONLY','Target is not editable');
    const local=start?.closest?.('p,li,h1,h2,h3,h4,h5,h6,pre,blockquote')||editor;
    if(!local.contains(range.endContainer))throw new Fault('CROSS_BLOCK','A selection spanning several blocks is not supported yet');
    desc={adapter:'richtext',node:local,kind:range.collapsed?'caret':'range',start:offsetIn(local,range.startContainer,range.startOffset,this.doc),end:offsetIn(local,range.endContainer,range.endOffset,this.doc)};
   }
  }
  const snap=await this.snapshot(desc);
  panelLog('kernel/begin/target', { adapter: desc.adapter, kind: desc.kind, start: desc.start ?? null, end: desc.end ?? null, chars: String(snap.text || '').length, revision: String(snap.revision || '').slice(0, 14), editable: snap.editable !== false });
  // The selection was captured BEFORE this task started. begin() must never re-certify stale
  // offsets against the current text: doing that is exactly how an edit lands on whatever moved
  // into those offsets. The captured selection has to still be the text at those offsets.
  const captured=typeof anchor.text==='string'?anchor.text:null;
  if(captured&&desc.kind!=='caret'){
   const from=desc.start??0,to=desc.end??snap.text.length;
   if(normalize(snap.text.slice(from,to))!==normalize(captured))throw new Fault('REVISION_CONFLICT','The selected text changed after it was chosen; select it again.');
  }
  // An input holds its whole value in one place, so any change is checkable directly.
  if(desc.adapter==='input'&&typeof anchor.full==='string'&&normalize(snap.text)!==normalize(anchor.full))throw new Fault('REVISION_CONFLICT','The editor text changed after it was chosen; select it again.');
  const ref=this.issue(desc,snap);
  panelLog('kernel/begin/exit', { ref: String(ref).slice(-8), kind: desc.kind, ok: true });
  this.defaultRef=ref;return this.read({});
  }catch(e){return e.outcome||fail('TARGET_UNAVAILABLE',String(e.message||e));}
 }
 publicTarget(t,s){
  const start=t.kind==='block'?0:t.start,end=t.kind==='block'?s.text.length:t.end,text=s.text.slice(start,end);
  const runs=Array.isArray(s.runs)?s.runs.slice(0,200):null;
  return {targetRef:t.ref,revision:s.revision,kind:t.kind,blockType:s.kind,adapter:t.adapter,recordId:t.recordId||null,start,end,text:text.slice(0,20000),truncated:text.length>20000,editable:s.editable,capabilities:s.capabilities,
   // What the target holds includes HOW it is formatted. Without runs a caller cannot check a style
   // edit, nor see the marks it is about to overwrite.
   ...(runs?{runs,runsTruncated:Array.isArray(s.runs)&&s.runs.length>runs.length}:{})};
 }
 async read(args){
  const valid=P.validateRead(args);if(!valid.ok)return valid;
  // A wider read is a query the caller chose, not a fixed response. Reading has no side effects,
  // so what may be inspected is the caller's decision; the write boundary is unchanged because
  // every location returned here still carries a ref this page issued.
  const scope=valid.value.scope;
  if(scope==='outline'||scope==='range'||scope==='keyword'){
   try{
    // A range is anchored by refs the page issued, so it cannot be pointed at an arbitrary block.
    const anchorOf=ref=>{const t=this.resolve(ref);if(t.adapter!=='feishu')throw new Fault('UNSUPPORTED_OPERATION','Document scopes read the Feishu editor model only');return t.recordId;};
    const listed=await this.bridge({version:2,action:'list',url:this.scope.url,mode:scope,limit:valid.value.limit,
     find:scope==='keyword'?valid.value.find:undefined,
     at:scope==='range'?anchorOf(args.at):undefined,
     to:scope==='range'&&args.to!==undefined?anchorOf(args.to):undefined,
     cursor:valid.value.cursor});
    if(!listed?.ok)return fail(listed?.code||'ADAPTER_UNAVAILABLE',listed?.message||'No editor response');
    const targets=[];
    for(const item of listed.items||[]){
     const snap={adapter:'feishu',kind:item.blockType,text:String(item.text||''),editable:item.editable===true,revision:item.revision,capabilities:item.capabilities,verification:'editor-model'};
     const ref=this.issue({adapter:'feishu',recordId:item.recordId,kind:'block',start:0,end:snap.text.length},snap);
     targets.push({...this.publicTarget(this.resolve(ref),snap),
      role:scope==='keyword'?'match':(scope==='range'?'range':'outline'),
      depth:item.depth??0,parentId:item.parentId??null});
    }
    return {ok:true,code:'READ',modification:'not-modified',verification:'editor-model',retryable:false,scope,
     total:listed.total,blocksInDocument:listed.blocksInDocument,returned:listed.returned,truncated:listed.truncated===true,
     ...(listed.cursor?{cursor:listed.cursor}:{}),targets,
     context:{note:scope==='outline'?'Top-level blocks only, in document order, from the editor model (including blocks not mounted in the DOM). This is a map: read a returned ref for its content, and write through the ref of the block you chose.':'Blocks in document order from the editor model, including blocks not currently mounted in the DOM. Write through the ref of a returned item.'}};
   }catch(e){return e.outcome||fail('READ_FAILED',String(e.message||e));}
  }
  // `at` is the same thing as the bound ref: either may name the read anchor.
  try{const t=this.resolve(args.at!==undefined?args.at:args.targetRef),snap=await this.snapshot(t);
   if(t.kind!=='block'&&t.end>snap.text.length)throw new Fault('STALE_RANGE','Captured offsets no longer exist');
   if(snap.revision!==t.snapshot.revision&&(t.kind==='range'||t.kind==='caret'))throw new Fault('REVISION_CONFLICT','Captured range changed; read its containing block or reselect');
   const freshRef=this.issue(t,snap),fresh=this.resolve(freshRef),target=this.publicTarget(fresh,snap),targets=[],context={};
   if(args.findText!==undefined){const a=t.kind==='block'?0:t.start,b=t.kind==='block'?snap.text.length:t.end;let n=a;
    while(n<=b){const i=snap.text.indexOf(args.findText,n);if(i<0||i+args.findText.length>b)break;const ref=this.issue({...t,kind:'range',start:i,end:i+args.findText.length},snap);targets.push(this.publicTarget(this.resolve(ref),snap));n=i+Math.max(1,args.findText.length);if(targets.length===64){context.matchesTruncated=true;break;}}}
   else{
    const blockRef=this.issue({...t,kind:'block',start:0,end:snap.text.length},snap);context.containingBlock=this.publicTarget(this.resolve(blockRef),snap);
    if(this.contextCell?.isConnected&&t.adapter==='feishu'){
     const seen=new Set();const blocks=[...this.contextCell.querySelectorAll('[data-record-id][data-block-type]')].filter(el=>el.closest('td,th')===this.contextCell&&!['table_cell','table','page'].includes(el.getAttribute('data-block-type')));
     for(const block of blocks){const recordId=block.getAttribute('data-record-id');if(!recordId||seen.has(recordId))continue;seen.add(recordId);const d={adapter:'feishu',recordId,kind:'block',start:0,end:0};try{const s=await this.snapshot(d);d.end=s.text.length;const ref=this.issue(d,s);targets.push(this.publicTarget(this.resolve(ref),s));}catch{context.partial=true;}if(targets.length===32){context.truncated=true;break;}}
     context.cell={role:'reference-only',atomicReplacement:false,blockCount:blocks.length};
    }
   }
   return {ok:true,code:'READ',modification:'not-modified',verification:snap.verification,retryable:false,targetRef:freshRef,target,targets,context,capabilities:target.capabilities};
  }catch(e){return e.outcome||fail('READ_FAILED',String(e.message||e));}
 }
 validateTargetOperation(t,s,op){
  if(!s.editable)throw new Fault('READ_ONLY','Target is not editable');
  if(!s.capabilities.operations.includes(op.type))throw new Fault('UNSUPPORTED_OPERATION','Adapter does not support this operation');
  if(op.type==='replace-block'&&t.kind!=='block')throw new Fault('SCOPE_MISMATCH','replace-block requires an explicit block ref');
  if(op.type==='replace-selection'&&(t.kind!=='range'||t.start===t.end))throw new Fault('EMPTY_SELECTION','replace-selection requires a nonempty range');
  if(op.type==='insert-at-caret'&&t.kind!=='caret')throw new Fault('NOT_A_CARET','Insertion requires a caret, not a range or block');
  if(op.type==='keep-block-kind'&&t.kind==='caret')throw new Fault('SCOPE_MISMATCH','Select text or a block before rewriting');
  if(op.type==='set-format'){
   if(t.kind==='caret')throw new Fault('EMPTY_SELECTION','Formatting requires a range or block');
   for(const k of Object.keys(op.format)){if(!s.capabilities.formats.includes(k))throw new Fault('UNSUPPORTED_FORMAT','Unsupported field '+k);if((op.format[k]===null||op.format[k]===false)&&!s.capabilities.clearFormats.includes(k))throw new Fault('UNSUPPORTED_FORMAT','Clearing '+k+' is not supported');}
   if(Object.hasOwn(op.format,'autoNumber')&&t.kind!=='block')throw new Fault('SCOPE_MISMATCH','autoNumber needs a heading block ref');
  }else if(!s.capabilities.contentTypes.includes(op.contentType))throw new Fault('UNSUPPORTED_CONTENT_TYPE','Adapter supports '+s.capabilities.contentTypes.join(', '));
 }
  async edit(args, signal){
  const v=P.validateEdit(args);if(!v.ok)return v;
    panelLog('kernel/edit/enter', { ref: String(args && args.ref || '').slice(0, 20), action: String(args && args.operation && args.operation.type || '').slice(0, 24) });
  const state={submitted:false};
  try{
   const t=this.resolve(args.targetRef),before=await this.snapshot(t),op=v.value.operation;
   if(args.expectedRevision!==before.revision||t.snapshot.revision!==before.revision)throw new Fault('REVISION_CONFLICT','Target changed since issued; read before editing');
   this.validateTargetOperation(t,before,op);
   if(signal?.aborted)throw new Fault('CANCELLED','Cancelled before submission');this.identity();
   const a=t.kind==='block'?0:t.start,b=t.kind==='block'?before.text.length:t.end;
   panelLog('kernel/edit/target', { adapter: t.adapter, kind: t.kind, range: [a, b], chars: String(before.text || '').length, revision: String(before.revision || '').slice(0, 14), op: op.type });
   panelLog('kernel/edit/write', { adapter: t.adapter, op: op.type, contentType: op.contentType || 'plain' });
   const written=await this.adapter(t.adapter).write(this.context(state),t,before,a,b,op,signal);
   const result=written.result,after=written.after;
   panelLog('kernel/edit/result', { code: result.code, ok: result.ok, modification: result.modification }, result.ok ? 'info' : 'error');
   // A run that could not even be attempted reports itself; an attempted run carries what it observed.
   if(!result.ok)return written.passthrough?result:{...result,observed:{text:after?.text?.slice(0,20000)||'',truncated:(after?.text?.length||0)>20000}};
   const end=op.type==='set-format'?b:a+op.text.length;
   const ref=this.issue({...t,start:a,end,kind:t.kind==='caret'?'range':t.kind},after),updated=this.resolve(ref);if(t.ref===this.defaultRef)this.defaultRef=ref;
   const {snapshot:unused,...clean}=result;
   return {...clean,targetRef:ref,target:this.publicTarget(updated,after),observed:{text:after.text.slice(0,20000),truncated:after.text.length>20000,
    // null means not checked, never confirmed: only an adapter that examined the surrounding
    // marks may claim the range outside the edit was left alone.
    rangeOutsideConfirmed:result.observed?.rangeOutsideConfirmed??null}};
  }catch(e){return e.outcome||fail('EDIT_FAILED',String(e.message||e),{modification:state.submitted?'unknown':'not-modified'});}
 }
 execute(command,signal){
  if(!this.scope||command.version!==2||command.taskId!==this.scope.taskId||command.documentId!==this.documentId)return Promise.resolve(fail('TASK_MISMATCH','Command belongs to another task/document'));
  if(this.completed.has(command.commandId))return Promise.resolve(this.completed.get(command.commandId));if(this.inflight.has(command.commandId))return this.inflight.get(command.commandId);
  panelLog('kernel/execute/accepted', { commandId: String(command.commandId || '').slice(-8), taskId: String(command.taskId || '').slice(-8) });
  const scopeId=this.scope.taskId;
  const work=this.tail.then(async()=>{if(signal?.aborted||scopeId!==this.scope?.taskId)return fail('CANCELLED','Cancelled before execution');this.activeEdit=true;try{return command.kind==='read'?await this.read(command.args):await this.edit(command.args,signal);}finally{this.activeEdit=false;}}).catch(e=>fail('EXECUTOR_ERROR',String(e.message||e),{modification:'unknown'})).then(result=>{const clean=P.validateOutcome(result);this.completed.set(command.commandId,clean);this.inflight.delete(command.commandId);return clean;});
  this.inflight.set(command.commandId,work);this.tail=work.then(()=>{});return work;
 }
 async dispose(){this.scope=null;this.registry.clear();await this.tail;this.completed.clear();this.inflight.clear();}
}
return {Kernel,Fault,hash,plainRange};
});
