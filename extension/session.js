export function allowedUrl(value){try{const u=new URL(value);return value==='about:blank'||(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['studio.oshi-labs.com','x.com','www.x.com','twitter.com'].includes(u.hostname));}catch{return false;}}
export class ChromeSession {
  constructor(api,emit,windowId){this.api=api;this.emit=emit;this.windowId=windowId;this.tabs=new Map();this.disposed=false;this.serial=0;}
  async create(url){
    if(!allowedUrl(url))throw new Error('仅允许 Oshi 和 X 工作页面');
    const tab=await this.api.tabs.create({url,active:true,...(Number.isInteger(this.windowId)?{windowId:this.windowId}:{})});
    if(this.disposed){await this.api.tabs.remove(tab.id).catch(()=>{});throw new Error('连接已结束');}
    const row={tabId:tab.id,sessionId:'oshi-'+(++this.serial),children:new Set()};this.tabs.set(tab.id,row);
    try{
      await this.api.debugger.attach({tabId:tab.id},'1.3');
      const {targetInfo}=await this.api.debugger.sendCommand({tabId:tab.id},'Target.getTargetInfo');row.targetInfo={...targetInfo,browserContextId:targetInfo.browserContextId||'oshi-default'};
      if(this.disposed){await this.api.debugger.detach({tabId:tab.id}).catch(()=>{});throw new Error('连接已结束');}
      this.emit({method:'Target.attachedToTarget',params:{sessionId:row.sessionId,targetInfo:{...row.targetInfo,attached:true},waitingForDebugger:false}});
      return {targetId:targetInfo.targetId};
    }catch(e){this.tabs.delete(tab.id);await this.api.debugger.detach({tabId:tab.id}).catch(()=>{});throw e;}
  }
  find(sessionId){for(const row of this.tabs.values())if(row.sessionId===sessionId||row.children.has(sessionId))return row;throw new Error('标签页未授权或已断开');}
  event(source,method,params){
    const row=this.tabs.get(source.tabId);if(!row)return;
    if(method==='Target.attachedToTarget')row.children.add(params.sessionId);
    if(method==='Target.detachedFromTarget')row.children.delete(params.sessionId);
    this.emit({sessionId:source.sessionId||row.sessionId,method,params});
  }
  detached(tabId){const row=this.tabs.get(tabId);if(!row)return;this.tabs.delete(tabId);this.emit({method:'Target.detachedFromTarget',params:{sessionId:row.sessionId,targetId:row.targetInfo?.targetId}});}
  async navigated(tabId,url){if(this.tabs.has(tabId)&&!allowedUrl(url)){await this.api.debugger.detach({tabId}).catch(()=>{});this.detached(tabId);}}
  async command({method,params={},sessionId}){
    if(this.disposed)throw new Error('连接已结束');
    if(method==='Browser.getVersion')return {protocolVersion:'1.3',product:'Chrome/Extension',revision:'oshi',userAgent:'Oshi Chrome Extension'};
    if(method==='Browser.setDownloadBehavior')return {};
    if(!sessionId){
      if(method==='Target.setAutoAttach')return {};
      if(method==='Target.getTargetInfo')return {targetInfo:{targetId:'oshi-browser',type:'browser',title:'Oshi',url:'',attached:true}};
      if(method==='Target.createTarget')return this.create(params.url||'about:blank');
      if(method==='Target.closeTarget'){const row=[...this.tabs.values()].find(t=>t.targetInfo?.targetId===params.targetId);if(!row)return {success:false};await this.api.tabs.remove(row.tabId);this.detached(row.tabId);return {success:true};}
      if(method==='Browser.close'){await this.release();return {};}
      throw new Error('不支持的浏览器级命令：'+method);
    }
    const row=this.find(sessionId),tab=await this.api.tabs.get(row.tabId);
    if(!allowedUrl(tab.url||'')||tab.pendingUrl&&!allowedUrl(tab.pendingUrl))throw new Error('工作标签页离开 Oshi / X，已停止控制');
    if(method==='Page.navigate'&&!allowedUrl(params.url))throw new Error('禁止导航到其他网站');
    // No cookie export, browser-profile modification, or arbitrary target attachment.
    const denied=/^(?:Browser\.|Storage\.|Network\.(?:getAllCookies|getCookies|setCookie|setCookies|deleteCookies|clearBrowserCookies)|Target\.(?:createTarget|attachToTarget|attachToBrowserTarget|createBrowserContext))/;
    if(denied.test(method))throw new Error('该命令不在扩展接入范围内');
    return await this.api.debugger.sendCommand({tabId:row.tabId,...(row.sessionId===sessionId?{}:{sessionId})},method,params)||{};
  }
  async release(){this.disposed=true;await Promise.all([...this.tabs.values()].map(row=>this.api.debugger.detach({tabId:row.tabId}).catch(()=>{})));this.tabs.clear();}
}
