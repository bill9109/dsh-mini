/* Reliable content-side consumer. A lost response never repeats the edit. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else Object.defineProperty(root,'DSHPageChannel',{value:api,configurable:true});})(globalThis,function(){
 // Forward the content script's own records with EVERY outcome, not only failures, so a successful
 // run also leaves a trace of the steps it took.
const withRecent=o=>(typeof PANEL_RING==='undefined'?o:{...o,recent:PANEL_RING.slice(-24)});
 class Channel{
  constructor({send,kernel,onOutcome=()=>{},delay=ms=>new Promise(r=>setTimeout(r,ms))}){this.send=send;this.kernel=kernel;this.onOutcome=onOutcome;this.sleep=delay;this.wakers=new Set();this.delay=ms=>new Promise(r=>{const done=()=>{this.wakers.delete(done);r();};this.wakers.add(done);this.sleep(ms).then(done);});this.records=new Map();this.stopped=false;this.busy=Promise.resolve();}
  start(page,signal){this.page=page;this.signal=signal;this.stopped=false;this.busy=this.loop();return this.busy;}
  identity(){return {pageSession:this.page};}
  async deliver(record){
   for(let n=0;n<12;n++){
    const reply=await this.send({type:'page-result',...this.identity(),commandId:record.command.commandId,leaseId:record.command.leaseId,outcome:record.outcome}).catch(()=>null);
    if(reply?.ok){record.acked=true;return true;}
    await this.delay(Math.min(250*2**n,2000));
   }
   // Retain the result locally; page_operation_status is the only safe follow-up, not a fresh edit.
   this.onOutcome({ok:false,code:'REPORT_PENDING',modification:record.outcome.modification,verification:record.outcome.verification,retryable:false,commandId:record.command.commandId});return false;
  }
  async loop(){
   while(!this.stopped&&!this.signal?.aborted){
    const reply=await this.send({type:'page-claim',...this.identity()}).catch(()=>null);
    if(this.stopped||this.signal?.aborted)break;
    if(!reply?.ok){await this.delay(500);continue;}
    const command=reply.command;if(!command){await this.delay(200);continue;}
    if(command.taskId!==this.page.taskId||command.documentId!==this.page.documentId||command.version!==2)break;
    const saved=this.records.get(command.commandId);
    if(saved){if(saved.outcome&&!saved.acked)await this.deliver(saved);else await this.delay(200);continue;}
    const start=await this.send({type:'page-start',...this.identity(),commandId:command.commandId,leaseId:command.leaseId}).catch(()=>null);
    if(!start?.ok||!start.execute){await this.delay(200);continue;}
    const record={command,outcome:null,acked:false};this.records.set(command.commandId,record);
    this.currentCommand=command;
    record.outcome=await this.kernel.execute(command,this.signal);
    this.currentCommand=null;this.onOutcome(withRecent({...record.outcome,commandId:command.commandId}));
    // A committed write can finish after cancellation. Report its actual outcome even then.
    await this.deliver(record);
   }
  }
  /** A command was pushed: end the current idle wait so the next claim happens now. */
  wake(){for(const w of [...this.wakers])w();}
  async stop(){this.stopped=true;this.wake();await this.busy;}
 }
 return {Channel};
});
