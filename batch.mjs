import {Engine} from './engine.mjs';

export function concurrency(value) {
  const n=Number(value);if(!Number.isInteger(n)||n<1||n>10)throw new Error('同时运行数量须为 1–10');return n;
}
export class Batch {
  constructor(dataDir,journal,makeEngine=()=>new Engine(dataDir)) {
    this.makeEngine=makeEngine;this.journal=journal;this.entries=[];this.busy=false;this.phase='未扫描';this.limit=3;this.stopped=false;
  }
  snapshot(){return {busy:this.busy,phase:this.phase,limit:this.limit,workers:this.entries.map(e=>({id:e.source.id,name:e.source.name,stage:e.stage,error:e.error,disabled:e.disabled,total:e.total||0,...e.engine.snapshot()}))};}
  async each(items,limit,fn) {
    let cursor=0;
    await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(!this.stopped&&cursor<items.length){const item=items[cursor++];if(!item.disabled)await fn(item);}}));
  }
  prepare(sources,value=3) {
    if(this.busy)throw new Error('并行队列仍在运行，请先停止');
    const limit=concurrency(value);
    if(!Array.isArray(sources)||!sources.length||sources.length>30)throw new Error('请选择 1–30 个已启动环境');
    if(sources.some(p=>!p.running)||new Set(sources.map(p=>p.id)).size!==sources.length||new Set(sources.map(p=>p.source==='extension'?p.id:p.debugPort)).size!==sources.length)throw new Error('环境未启动或存在重复浏览器端口，请刷新环境后重选');
    const old=this.entries;this.limit=limit;this.busy=true;this.stopped=false;this.phase='正在扫描';
    this.entries=sources.map(source=>{const engine=this.makeEngine();engine.journal=this.journal;return {source,engine,stage:'等待扫描',disabled:false,error:null};});
    this.job=(async()=>{
      await Promise.all(old.map(e=>e.engine.adapter.release?.().catch(()=>{})));
      await this.each(this.entries,limit,async entry=>{
        entry.stage='正在连接';
        try {await entry.engine.connect(entry.source);if(this.stopped||entry.disabled){entry.stage='已停止';return;}entry.stage='待选择任务';}
        catch(e){entry.error=e.message;entry.stage=this.stopped||entry.disabled?'已停止':'连接失败';}
      });
      // Two environments signed into one account must not publish the same tasks concurrently.
      const accounts=new Set();
      for(const entry of this.entries){if(entry.stage!=='待选择任务')continue;const account=entry.engine.profile.account.toLowerCase();if(accounts.has(account)){entry.error='该 X 账号已在另一选中环境中使用，请只保留一个环境';entry.stage='账号重复';entry.disabled=true;}else accounts.add(account);}
      this.phase=this.stopped?'已停止':'扫描完成';
    })().catch(e=>{this.phase='扫描失败';for(const entry of this.entries)if(!entry.error)entry.error=e.message;}).finally(()=>{this.busy=false;});
  }
  start(plans,settings,value=3) {
    if(this.busy)throw new Error('并行队列正在运行');
    const limit=concurrency(value);
    if(!Array.isArray(plans)||!plans.length||new Set(plans.map(p=>p.id)).size!==plans.length)throw new Error('请选择各环境要运行的任务');
    const jobs=plans.map(p=>{const entry=this.entries.find(e=>e.source.id===p.id);if(!entry||entry.disabled||!entry.engine.profile||entry.stage==='连接失败')throw new Error('请重新扫描并选择已连接的环境');entry.engine.prepareRun(p.keys,settings,{});return {entry,keys:[...p.keys]};});
    // Validate every plan before any worker is started. Never include API keys in snapshots.
    this.limit=limit;this.busy=true;this.stopped=false;this.phase='正在运行';const config={...settings};
    for(const {entry,keys}of jobs){entry.error=null;entry.total=keys.length;entry.stage='等待运行';}
    this.job=this.each(jobs.map(job=>({...job,get disabled(){return job.entry.disabled;}})),limit,async({entry,keys})=>{
      entry.stage='正在运行';
      try{entry.engine.start(keys,{...config},{});await entry.engine.job;entry.stage=entry.engine.status;entry.error=entry.engine.lastError?.message||null;}
      catch(e){entry.error=e.message;entry.stage='需处理';}
    }).finally(()=>{config.apiKey='';this.busy=false;this.phase=this.stopped?'已停止':jobs.some(j=>j.entry.error)?'已结束，部分环境需处理':'并行队列完成';});
  }
  stop(id) {
    const entries=id?this.entries.filter(e=>e.source.id===id):this.entries;
    if(id&&!entries.length)throw new Error('未找到该环境');
    if(!id){this.stopped=true;this.phase=this.busy?'正在停止':'已停止';}
    for(const e of entries){e.disabled=true;if(e.engine.busy)e.engine.stop();if(['等待扫描','等待运行','待选择任务'].includes(e.stage))e.stage='已停止';}
  }
  approve(id,key,text){const entry=this.entries.find(e=>e.source.id===id);if(!entry||entry.disabled)throw new Error('该环境不可确认回复');entry.engine.approve(key,text);}
}
