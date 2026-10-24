const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Kernel}=require('../src/edit-core.js');
const P=require('../src/edit-protocol.js');
const {Channel}=require('../src/page-channel.js');
function fixture(value='before selected after',start=7,end=15){
 const events=[];const node={value,type:'textarea',tagName:'TEXTAREA',isConnected:true,readOnly:false,disabled:false,
 ownerDocument:{defaultView:{InputEvent:class{constructor(type,options){this.type=type;Object.assign(this,options)}}}},focus(){},dispatchEvent(e){events.push(e);return true},setRangeText(text,a,b){this.value=this.value.slice(0,a)+text+this.value.slice(b)}};
 let n=0;const location={href:'https://example.test/doc',hostname:'example.test'};const kernel=new Kernel({document:{},location,documentId:'doc',id:()=>String(++n),bridge:async()=>{throw Error('no bridge for input')}});
 const page={version:2,taskId:'task',documentId:'doc',selectionId:'sel',url:location.href,token:'secret'};
 return {kernel,node,page,events,anchor:{kind:'control',editor:node,start,end,full:value,text:value.slice(start,end)},location};
}
async function begin(f){const r=await f.kernel.begin(f.page,f.anchor);assert.equal(r.ok,true);return r;}
const args=(r,operation)=>({targetRef:r.targetRef,expectedRevision:r.target.revision,operation});
test('plain preserves JSON fences whitespace and newlines exactly',async()=>{const f=fixture();const r=await begin(f);const fence=String.fromCharCode(96).repeat(3);const text='  {"operations": []}\n| a | b |\n'+fence+'js\nx\n'+fence+'\n';const v=await f.kernel.edit(args(r,{type:'replace-selection',text,contentType:'plain'}));assert.equal(v.ok,true);assert.equal(f.node.value,'before '+text+' after');assert.equal(v.verification,'dom-observed');});
test('invalid explicit ref never falls back',async()=>{const f=fixture();const r=await begin(f);const v=await f.kernel.edit({...args(r,{type:'replace-block',text:'x'}),targetRef:'forged'});assert.equal(v.code,'STALE_TARGET');assert.equal(f.events.length,0);});
test('collapsed selection cannot become block overwrite',async()=>{const f=fixture('abcd',2,2);const r=await begin(f);assert.equal((await f.kernel.edit(args(r,{type:'replace-selection',text:'x'}))).code,'EMPTY_SELECTION');assert.equal(f.node.value,'abcd');const v=await f.kernel.edit(args(r,{type:'insert-at-caret',text:' X '}));assert.equal(v.ok,true);assert.equal(f.node.value,'ab X cd');});
test('insert on range refuses rather than replacing',async()=>{const f=fixture();const r=await begin(f);const v=await f.kernel.edit(args(r,{type:'insert-at-caret',text:'x'}));assert.equal(v.code,'NOT_A_CARET');assert.equal(f.events.length,0);});
test('block replacement requires explicit block ref',async()=>{const f=fixture();const r=await begin(f);assert.equal((await f.kernel.edit(args(r,{type:'replace-block',text:'x'}))).code,'SCOPE_MISMATCH');const b=r.context.containingBlock;const v=await f.kernel.edit({targetRef:b.targetRef,expectedRevision:b.revision,operation:{type:'replace-block',text:'full'}});assert.equal(v.ok,true);assert.equal(f.node.value,'full');});
test('text changed after capture refuses instead of editing the wrong words',async()=>{
 const f=fixture();const r=await begin(f);assert.equal(r.ok,true);
 const g=fixture();g.node.value='NEW before selected after';
 const stale=await g.kernel.begin(g.page,g.anchor);
 assert.equal(stale.ok,false);assert.equal(stale.code,'REVISION_CONFLICT');assert.equal(g.events.length,0);
 const h=fixture();h.node.value='before selected after plus';
 const after=await h.kernel.begin(h.page,h.anchor);
 assert.equal(after.ok,false);assert.equal(h.events.length,0);
});
test('revision conflict refuses before input events',async()=>{const f=fixture();const r=await begin(f);f.node.value+=' collaborative';const v=await f.kernel.edit(args(r,{type:'replace-selection',text:'x'}));assert.equal(v.code,'REVISION_CONFLICT');assert.equal(f.events.length,0);});
test('old task refs and changed URL refuse',async()=>{const f=fixture();const r=await begin(f);await f.kernel.begin({...f.page,taskId:'new'},f.anchor);assert.equal((await f.kernel.edit(args(r,{type:'replace-selection',text:'x'}))).code,'STALE_TARGET');f.location.href+='?other';assert.equal((await f.kernel.read({})).code,'PAGE_CHANGED');});
test('format only never clears input text',async()=>{const f=fixture();const r=await begin(f);const v=await f.kernel.edit(args(r,{type:'set-format',format:{bold:true}}));assert.equal(v.code,'UNSUPPORTED_OPERATION');assert.equal(f.node.value,'before selected after');assert.equal(f.events.length,0);});
test('findText returns exact ranges bounded by parent',async()=>{const f=fixture('xx word word yy',3,7);const r=await begin(f);const found=await f.kernel.read({targetRef:r.targetRef,findText:'word'});assert.equal(found.targets.length,1);assert.equal(found.targets[0].start,3);const b=r.context.containingBlock;const all=await f.kernel.read({targetRef:b.targetRef,findText:'word'});assert.equal(all.targets.length,2);});
test('duplicate command id executes once even concurrently',async()=>{const f=fixture();const r=await begin(f);const c={version:2,taskId:'task',documentId:'doc',commandId:'cmd',kind:'edit',args:args(r,{type:'replace-selection',text:'new'})};const [a,b]=await Promise.all([f.kernel.execute(c),f.kernel.execute(c)]);assert.equal(a.ok,true);assert.deepEqual(a,b);assert.equal(f.events.filter(e=>e.type==='input').length,1);await f.kernel.execute(c);assert.equal(f.events.filter(e=>e.type==='input').length,1);});
test('non-editable target refuses every write before any event',async()=>{
 const node={nodeType:1,tagName:'DIV',isConnected:true,isContentEditable:false,textContent:'fixed text',innerHTML:'fixed text',contains:()=>true,closest:()=>null};
 const location={href:'https://example.test/doc',hostname:'example.test'};
 let n=0;
 const kernel=new Kernel({document:{createRange:()=>({selectNodeContents(){},setEnd(){},setStart(){},toString:()=>''})},location,documentId:'doc',id:()=>String(++n),bridge:async()=>{throw Error('no bridge')}});
 const page={version:2,taskId:'t',documentId:'doc',selectionId:'s',url:location.href,token:'x'.repeat(20)};
 const start={nodeType:3,parentElement:node,isConnected:true},end={nodeType:3,parentElement:node,isConnected:true};
 const range={collapsed:false,startContainer:start,endContainer:end,startOffset:0,endOffset:5};
 const r=await kernel.begin(page,{kind:'range',range,editor:node});
 assert.equal(r.ok,false);
 assert.equal(r.code,'READ_ONLY');
 assert.equal(node.textContent,'fixed text');
});
test('cancel before submission causes zero edits',async()=>{const f=fixture();const r=await begin(f);const a=new AbortController();a.abort();const v=await f.kernel.edit(args(r,{type:'replace-selection',text:'x'}),a.signal);assert.equal(v.code,'CANCELLED');assert.equal(f.events.length,0);});
test('canonical result preserves target fields',()=>{const r={ok:true,code:'READ',modification:'not-modified',verification:'editor-model',targetRef:'t',target:{revision:'r'},targets:[{targetRef:'sub'}],capabilities:{formats:['bold']},retryable:false};assert.deepEqual(P.validateOutcome(r),r);});
test('format clear differs from absence and unknown fields refuse',()=>{assert.equal(P.validateEdit({expectedRevision:'r',operation:{type:'set-format',format:{highlight:null,autoNumber:false}}}).ok,true);assert.equal(P.validateEdit({expectedRevision:'r',operation:{type:'set-format',format:{nonsense:true}}}).code,'UNSUPPORTED_FORMAT');assert.equal(P.validateEdit({expectedRevision:'r',operation:{type:'set-format',text:'',format:{bold:true}}}).ok,false);});
test('empty text allowed but missing revision refuses',()=>{assert.equal(P.validateEdit({expectedRevision:'r',operation:{type:'replace-selection',text:''}}).ok,true);assert.equal(P.validateEdit({operation:{type:'replace-selection',text:'x'}}).code,'REVISION_REQUIRED');});
test('unchecked surroundings are reported as unknown, not confirmed',async()=>{
 const f=fixture();const r=await begin(f);
 const v=await f.kernel.edit(args(r,{type:'replace-selection',text:'X'}));
 assert.equal(v.ok,true);
 // The input adapter compares text only, so it must not claim the rest of the target was verified.
 assert.equal(v.observed.rangeOutsideConfirmed,null);
});
test('formatting runs survive into the read target only when observable',()=>{
 let n=0;const kernel=new Kernel({document:{},location:{href:'https://example.test/',hostname:'example.test'},documentId:'d',id:()=>String(++n)});
 const withRuns=kernel.publicTarget({ref:'x',kind:'range',start:0,end:2},{revision:'r',text:'ab',kind:'text',adapter:'feishu',editable:true,capabilities:{},runs:[{start:0,end:1,text:'a',marks:{bold:true}},{start:1,end:2,text:'b',marks:{bold:false}}]});
 assert.equal(withRuns.runs.length,2);assert.equal(withRuns.runs[0].marks.bold,true);assert.equal(withRuns.runsTruncated,false);
 const without=kernel.publicTarget({ref:'y',kind:'range',start:0,end:1},{revision:'r',text:'a',kind:'text',adapter:'input',editable:true,capabilities:{}});
 assert.equal('runs' in without,false);
});
const feishu=require('../src/adapters/feishu.js');
const compatFault=(code,message)=>Object.assign(new Error(message),{code,outcome:{ok:false,code,message,modification:'not-modified',verification:'none',retryable:false}});
test('feishu adapter reports editor-model reads and never invents a snapshot',async()=>{
 const ctx={scope:{url:'https://x.feishu.cn/docx/1'},fault:compatFault,validateOutcome:x=>x,mark(){}};
 const read=await feishu.snapshot({...ctx,bridge:async()=>({ok:true,code:'READ',snapshot:{text:'ab',revision:'r1',editable:true,capabilities:{}}})},{recordId:'r'});
 assert.equal(read.adapter,'feishu');assert.equal(read.verification,'editor-model');assert.equal(read.text,'ab');
 let code=null;
 try{await feishu.snapshot({...ctx,bridge:async()=>({ok:false,code:'ADAPTER_UNAVAILABLE'})},{recordId:'r'});}catch(error){code=error.outcome?.code;}
 assert.equal(code,'ADAPTER_UNAVAILABLE');
 const pending=await feishu.write({...ctx,bridge:async()=>null},{recordId:'r'},{revision:'r1',text:'ab'},0,1,{type:'replace-selection',text:'x'});
 assert.equal(pending.result.ok,false);assert.equal(pending.result.modification,'unknown');assert.equal(pending.passthrough,true);
 const refused=await feishu.write({...ctx,bridge:async()=>({ok:false,code:'REVISION_CONFLICT',modification:'not-modified',verification:'none',retryable:false})},{recordId:'r'},{revision:'r1',text:'ab'},0,1,{type:'replace-selection',text:'x'});
 assert.equal(refused.result.code,'REVISION_CONFLICT');assert.equal(refused.result.ok,false);
});// feishu-engine.js is a MAIN-world browser module: loading it publishes its global, which is the
// surface the content script and the injected bridge both use.
require('../src/feishu-engine.js');
const feishuEngine=globalThis.DSHFeishuV2;
test('range-outside proof covers every attribute, not just the managed formats',()=>{
 const managed=['bold','textHighlight'];
 const before=[{raw:{bold:'true',link:'https://a.example'}},{raw:{author:'7',inlineCode:'true'}}];
 const same=[{raw:{bold:'true',link:'https://a.example'}},{raw:{author:'7',inlineCode:'true'}}];
 // A managed field may change; any other attribute difference must be caught.
 const changedManaged=[{raw:{bold:'false',link:'https://a.example'}},{raw:{author:'7',inlineCode:'true'}}];
 const droppedLink=[{raw:{bold:'true'}},{raw:{author:'7',inlineCode:'true'}}];
 const droppedCode=[{raw:{bold:'true',link:'https://a.example'}},{raw:{author:'7'}}];
 assert.equal(feishuEngine.unmanagedPreserved(before[0].raw,same[0].raw),true);
 assert.equal(feishuEngine.unmanagedPreserved(before[0].raw,changedManaged[0].raw),true);
 assert.equal(feishuEngine.unmanagedPreserved(before[0].raw,droppedLink[0].raw),false);
 assert.equal(feishuEngine.unmanagedPreserved(before[1].raw,droppedCode[1].raw),false);
 assert.equal(feishuEngine.slicePreserved(before,same,0,0,2),true);
 assert.equal(feishuEngine.slicePreserved(before,droppedLink,0,0,2),false);
 // A replacement that changes length must still compare the CORRESPONDING tail, not the same index.
 const long=[{raw:{}},{raw:{}},{raw:{}},{raw:{}}];
 const short=[{raw:{}},{raw:{}}];
 assert.equal(feishuEngine.slicePreserved(long,short,4,2,0),true);
 assert.equal(feishuEngine.slicePreserved(long,short,2,2,2),true);
});test('read scopes are validated and findText keeps its original meaning',()=>{
 assert.equal(P.validateRead({}).value.scope,'target');
 // findText alone still searches the bound target; it must NOT silently widen to the document.
 assert.equal(P.validateRead({findText:'x'}).value.scope,'target');
 assert.equal(P.validateRead({scope:'keyword',find:'x'}).ok,true);
 assert.equal(P.validateRead({scope:'keyword'}).code,'INVALID_ARGUMENT');
 // A range must start somewhere, and document scopes must not also name a target.
 assert.equal(P.validateRead({scope:'range'}).code,'INVALID_ARGUMENT');
 assert.equal(P.validateRead({scope:'range',at:'r1',to:'r2'}).ok,true);
 assert.equal(P.validateRead({scope:'outline',targetRef:'r1'}).code,'INVALID_ARGUMENT');
 assert.equal(P.validateRead({scope:'range',at:'r1',to:'r2'}).value.scope,'range');
 assert.equal(P.validateRead({scope:'nope'}).code,'INVALID_SCOPE');
 // An unimplemented scope must be refused, not silently treated as the bound target.
 assert.equal(P.validateRead({scope:'block'}).code,'INVALID_SCOPE');
 assert.equal(P.validateRead({scope:'window'}).code,'INVALID_SCOPE');
 assert.equal(P.validateRead({limit:0}).code,'INVALID_LIMIT');
 assert.equal(P.validateRead({limit:101}).code,'INVALID_LIMIT');
 assert.equal(P.validateRead({detail:'text'}).code,'INVALID_ARGUMENT');
 assert.equal(P.validateRead({cursor:'x'.repeat(513)}).code,'INVALID_CURSOR');
 assert.equal(P.validateRead({nonsense:1}).code,'INVALID_ARGUMENT');
 assert.equal(P.validateRead({scope:'outline',limit:100}).value.limit,100);
});test('outline and range are refused on adapters without a document model',async()=>{
 const f=fixture();const r=await begin(f);
 // The input adapter has no block manager: a document scope must fail loudly, not return nothing.
 const outline=await f.kernel.read({scope:'outline'});
 assert.equal(outline.ok,false);
 const range=await f.kernel.read({scope:'range',at:r.targetRef});
 assert.equal(range.ok,false);
});test('lost result report is retried without another edit',async()=>{let edits=0,reports=0;let channel;const page={taskId:'t',documentId:'d'},c={version:2,taskId:'t',documentId:'d',commandId:'c',leaseId:'l',kind:'edit'};channel=new Channel({delay:async()=>{},kernel:{execute:async()=>{edits++;return {ok:true,code:'EDIT_APPLIED',modification:'modified',verification:'editor-model',retryable:false}}},send:async m=>{if(m.type==='page-claim')return {ok:true,command:c};if(m.type==='page-start')return {ok:true,execute:true};if(m.type==='page-result'){reports++;if(reports===1)return {ok:false};channel.stopped=true;return {ok:true};}}});await channel.start(page);assert.equal(edits,1);assert.equal(reports,2);});
