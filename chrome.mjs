import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

export function chromePort(value) {
  if(!/^\d{4,5}$/.test(String(value)))throw new Error('请输入 1024–65535 之间的本机调试端口');
  const port=Number(value);if(port<1024||port>65535)throw new Error('请输入 1024–65535 之间的本机调试端口');return port;
}
export async function chromeEndpoint(port,fetcher=fetch) {
  port=chromePort(port);
  const response=await fetcher(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1500),redirect:'error'});
  if(!response.ok)throw new Error('Chrome 调试接口未响应');
  const info=await response.json();const ws=new URL(info.webSocketDebuggerUrl);
  if(!/Chrome\//.test(info.Browser||'')||ws.protocol!=='ws:'||!['127.0.0.1','localhost','[::1]'].includes(ws.hostname)||Number(ws.port)!==port||!ws.pathname.startsWith('/devtools/browser/'))throw new Error('该端口不是有效的本机 Chrome 调试接口');
  return ws;
}
export class LocalChrome {
  constructor(root,{fetcher=fetch,spawnProcess=spawn,exists=fs.existsSync}={}) {this.root=root;this.dir=path.join(root,'Chrome');this.file=path.join(root,'connections.json');this.fetcher=fetcher;this.spawnProcess=spawnProcess;this.exists=exists;this.launching=false;}
  saved(){return this.exists(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):[];}
  async own() {
    try {
      const [value,browserPath]=fs.readFileSync(path.join(this.dir,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/);
      const port=chromePort(value),ws=await chromeEndpoint(port,this.fetcher);
      if(ws.pathname!==browserPath)return null;
      return port;
    } catch{return null;}
  }
  async profiles() {
    const port=await this.own();
    const extra=await Promise.all(this.saved().map(async p=>{let running=false;try{await chromeEndpoint(p.debugPort,this.fetcher);running=true;}catch{}return {...p,running,source:'chrome'};}));
    return [{id:'local-chrome',name:'普通 Chrome（独立登录环境）',source:'chrome',debugPort:port,running:Boolean(port)},...extra.filter(p=>p.debugPort!==port)];
  }
  async add(value) {
    const port=chromePort(value);await chromeEndpoint(port,this.fetcher);
    if(port===await this.own())return 'local-chrome';
    const entry={id:`chrome:${port}`,name:`普通 Chrome · 端口 ${port}`,debugPort:port};
    const rows=this.saved().filter(p=>p.id!==entry.id);rows.push(entry);
    fs.mkdirSync(this.root,{recursive:true});fs.writeFileSync(this.file,JSON.stringify(rows,null,2));return entry.id;
  }
  async launch() {
    if(this.launching)throw new Error('普通 Chrome 正在启动，请稍后刷新环境');
    this.launching=true;
    try {
      if(await this.own())return 'local-chrome';
      const candidates=[process.env.PROGRAMFILES,process.env['PROGRAMFILES(X86)'],process.env.LOCALAPPDATA].filter(Boolean).map(p=>path.join(p,'Google','Chrome','Application','chrome.exe'));
      const executable=candidates.find(p=>this.exists(p));if(!executable)throw new Error('没有找到本机 Google Chrome，请先安装 Chrome');
      fs.mkdirSync(this.dir,{recursive:true});
      const child=this.spawnProcess(executable,[`--user-data-dir=${this.dir}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','https://studio.oshi-labs.com/?tab=tasks','https://x.com/home'],{detached:true,stdio:'ignore',windowsHide:true});
      let launchError;child.once('error',e=>{launchError=e;});child.unref();
      for(let i=0;i<40;i++){if(launchError)throw new Error('无法启动 Chrome：'+launchError.message);if(await this.own())return 'local-chrome';await new Promise(r=>setTimeout(r,250));}
      throw new Error('尚未检测到普通 Chrome。请稍后刷新环境；如果旧窗口仍在运行，请关闭该独立窗口后重试');
    } finally{this.launching=false;}
  }
}
