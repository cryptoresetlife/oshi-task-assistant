import { BrowserAdapter } from './browser.mjs';
import { Journal, journalKey, nextAction, validateReply, validateReplyUrl, generateReply, endpointUrl } from './core.mjs';

export class Engine {
  constructor(dataDir,adapterFactory) {
    this.journal=new Journal(dataDir); this.events=[]; this.tasks=[]; this.profile=null; this.busy=false; this.stopFlag=false;
    this.status='未连接'; this.current=null; this.pending=null; this.lastError=null; this.controller=new AbortController();
    this.makeAdapter=adapterFactory||(()=>new BrowserAdapter(m=>this.log(m),()=>this.check()));
    this.adapter=this.makeAdapter();
  }
  log(message) { this.events.push({time:new Date().toLocaleTimeString('zh-CN',{hour12:false}),message}); this.events=this.events.slice(-200); }
  check() { if(this.stopFlag) throw new Error('已停止；已经发出的操作不会撤销'); }
  snapshot() {
    return {profile:this.profile,busy:this.busy,status:this.status,current:this.current,pending:this.pending,lastError:this.lastError,tasks:this.tasks,events:this.events,
      records:this.profile?Object.values(this.journal.data).filter(r=>r.profile===this.profile.id&&r.account===this.profile.account):[]};
  }
  async connect(profile) {
    if(this.busy) throw new Error('任务正在运行');
    this.busy=true; this.stopFlag=false;
    const previous=this.adapter,candidate=this.makeAdapter();
    this.status=this.profile?'正在切换环境':'连接中';
    try {
      await candidate.connect(profile.debugPort);
      const account=await candidate.oshiAccount();
      const tasks=await candidate.scan();this.check();
      // Commit only after the candidate is fully usable; failures retain the old environment.
      this.adapter=candidate;
      this.profile={id:profile.id,name:profile.name,debugPort:profile.debugPort,account};
      this.tasks=tasks;this.pending=null;this.current=null;this.lastError=null;this.events=[];
      this.status='已连接'; this.log(`已连接 ${profile.name}，Oshi 账号 @${account}，${this.tasks.length} 个待办任务`);
      await previous.release?.().catch(e=>this.log('旧环境控制连接清理失败：'+e.message));
    } catch(e) {
      await candidate.release?.().catch(()=>{});
      this.status=this.profile?'切换失败，保留原环境':'未连接';this.log(e.message);throw e;
    } finally {this.busy=false;}
  }
  async scan() {
    if(this.busy || !this.profile) throw new Error('请先连接，且等待当前任务结束');
    this.busy=true; this.stopFlag=false;
    try {
      await this.adapter.closeDialog(); await this.adapter.oshi.reload({waitUntil:'domcontentloaded'});
      const account=await this.adapter.oshiAccount();
      if(account!==this.profile.account) throw new Error('Oshi 账号已变化，请重启助手后重新连接');
      this.tasks=await this.adapter.scan();return this.tasks;
    } finally{this.busy=false;}
  }
  prepareRun(keys,settings,drafts={}) {
    if(this.busy || !this.profile) throw new Error('请先连接，且等待当前任务结束');
    if(!Array.isArray(keys)||!keys.length||keys.length>60) throw new Error('请选择 1–60 个任务');
    const selected=[...new Set(keys)].map(k=>this.tasks.find(t=>t.key===k));
    if(selected.some(t=>!t||t.type==='manual'))throw new Error('包含未识别或需手动完成的任务');
    if(!['manual','auto'].includes(settings.mode))throw new Error('请选择回复模式');
    if(selected.some(t=>t.type==='reply'&&nextAction(this.journal.get(journalKey(this.profile.id,this.profile.account,t)))==='publish')) {
      if(settings.mode==='auto') {endpointUrl(settings.endpoint);if(!settings.model?.trim())throw new Error('请填写模型名称');}
      if(settings.mode==='manual') for(const task of selected.filter(t=>t.type==='reply')) {
        const record=this.journal.get(journalKey(this.profile.id,this.profile.account,task));
        if(nextAction(record)==='publish')validateReply(drafts[task.key]||settings.text);
      }
    }
    settings={...settings,interval:Math.min(300,Math.max(5,Number(settings.interval)||15)),autoPublish:settings.autoPublish===true,like:settings.like===true};
    return {selected,settings,drafts};
  }
  start(keys,input,drafts={}) {
    const {selected,settings}=this.prepareRun(keys,input,drafts);
    this.busy=true;this.stopFlag=false;this.lastError=null;this.controller=new AbortController();this.status='运行中';
    this.job=this.run(selected,settings,drafts).catch(e=>{
      this.status=this.stopFlag?'已停止':'需处理';
      const detail=e.message.replace(/\u001b\[[0-9;]*m/g,'');this.log(detail);
      if(!this.stopFlag){const task=this.tasks.find(t=>t.key===this.current);const key=task&&journalKey(this.profile.id,this.profile.account,task);const record=key?this.journal.get(key):{};
        this.lastError={task:this.current,message:record.replyUrl?'回复已发布，但后续校验或提交没有完成。链接已保存，请在执行记录点击“只续交此链接”。':`任务已暂停：${detail.split('\n')[0]}`,detail};
        if(key)this.save(key,task,{error:detail});
      }
    })
      .finally(()=>{this.busy=false;this.pending=null;this.current=null;this.resolvePending=null;settings.apiKey='';});
  }
  async run(tasks,settings,drafts) {
    for(const task of tasks) {
      this.check(); this.current=task.key; this.log(`处理 ${task.title} · ${task.url}`);
      const key=journalKey(this.profile.id,this.profile.account,task);
      let record=this.journal.get(key);
      if(await this.adapter.completed(task)) {this.save(key,task,{stage:'done',error:null});this.tasks=this.tasks.filter(t=>t.key!==task.key);this.log('网站已标记完成，跳过');continue;}
      if(nextAction(record)==='skip') {this.tasks=this.tasks.filter(t=>t.key!==task.key);this.log('本地记录已完成，跳过');continue;}
      if(nextAction(record)==='recover') throw new Error('该任务上次发布结果不确定，请先在下方记录中补填回复链接，避免重复发帖');
      const expected=this.profile.account;
      const account=await this.adapter.openTarget(task);
      if(account!==expected)throw new Error(`账号不一致：Oshi @${expected} / X @${account}。请切换为同一账号`);
      this.adapter.expectedAccount=expected;
      if(task.type==='reply') {
        if(record.replyUrl) this.log('恢复已有回复：只校验和提交链接');
        else {
          const text=settings.mode==='auto'?await generateReply(settings,await this.adapter.postText(task),this.controller.signal):validateReply(drafts[task.key]||settings.text);
          this.save(key,task,{stage:'prepared',text});
          let finalText=text;
          if(!settings.autoPublish) finalText=await this.review(task,text);
          finalText=validateReply(finalText); this.check();
          if(settings.like)await this.adapter.like(task);
          const url=await this.adapter.publish(task,finalText,async()=>{
            this.check();this.save(key,task,{stage:'posting',text:finalText,startedAt:new Date().toISOString()});
          });
          this.save(key,task,{stage:'posted',replyUrl:url}); this.log('已保存回复链接：'+url);
        }
        record=this.journal.get(key);
        await this.adapter.verifyReply(task,record.replyUrl,expected,record.text);
        await this.adapter.submitReply(task,record.replyUrl,expected);
      } else {
        if(task.type==='follow')await this.adapter.follow(task);
        if(task.type==='like')await this.adapter.like(task);
        if(task.type==='repost')await this.adapter.repost(task);
        this.save(key,task,{stage:'acted'}); await this.adapter.submitSimple(task);
      }
      this.save(key,task,{stage:'done',error:null}); this.log('已确认 Oshi 任务完成');
      this.tasks=this.tasks.filter(t=>t.key!==task.key);
      await this.adapter.cleanupTarget();
      if(task!==tasks[tasks.length-1]) for(let i=0;i<settings.interval*4;i++){this.check();await new Promise(r=>setTimeout(r,250));}
    }
    this.tasks=await this.adapter.scan();this.status='队列完成';this.log('所选任务处理结束');
  }
  save(key,task,changes) {return this.journal.set(key,{profile:this.profile.id,account:this.profile.account,task:task.key,type:task.type,title:task.title,target:task.url,...changes});}
  resumeOnly(taskKey) {
    if(!this.profile||this.busy)throw new Error('请先连接并等待队列停止');
    const task=this.tasks.find(t=>t.key===taskKey&&t.type==='reply');
    if(!task)throw new Error('未找到这条待办评论任务，请刷新任务列表');
    const record=this.journal.get(journalKey(this.profile.id,this.profile.account,task));
    if(!record.replyUrl)throw new Error('没有已保存的回复链接，不能续交');
    this.start([task.key],{mode:'manual',autoPublish:false,like:false,interval:5});
  }
  review(task,text) {
    this.status='等待预览确认';this.pending={key:task.key,title:task.title,url:task.url,text};this.log('回复已生成，等待你检查或编辑');
    return new Promise((resolve,reject)=>{this.resolvePending={resolve,reject};});
  }
  approve(key,text) {
    if(!this.pending||key!==this.pending.key)throw new Error('没有对应的待确认回复');
    const value=validateReply(text), resolver=this.resolvePending;
    this.pending=null;this.resolvePending=null;this.status='运行中';resolver.resolve(value);
  }
  stop() {this.stopFlag=true;this.controller.abort();this.resolvePending?.reject(new Error('已停止'));this.resolvePending=null;this.pending=null;this.status='正在停止';this.log('停止请求已接收，正在结束当前步骤');}
  async recover(taskKey,url) {
    if(this.busy||!this.profile)throw new Error('请在队列停止后补填链接');
    const task=this.tasks.find(t=>t.key===taskKey&&t.type==='reply');if(!task)throw new Error('请先刷新，找到相应待办评论任务');
    const key=journalKey(this.profile.id,this.profile.account,task), record=this.journal.get(key);
    if(!['posting','uncertain','posted','prepared'].includes(record.stage))throw new Error('此任务没有可恢复的回复记录');
    const replyUrl=validateReplyUrl(url,this.profile.account,task.url);
    this.stopFlag=false;this.busy=true;
    try {
      await this.adapter.verifyReply(task,replyUrl,this.profile.account,record.text);
      this.save(key,task,{stage:'posted',replyUrl});this.log('链接已校验保存，重新运行该任务即可继续提交');
    } finally{this.busy=false;}
  }
}
