import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Engine } from './engine.mjs';
import { LocalChrome, chromeEndpoint } from './chrome.mjs';
import { Batch } from './batch.mjs';
import { ExtensionBridge } from './bridge.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const buildStamp=()=>crypto.createHash('sha256').update(['server.mjs','browser.mjs','engine.mjs','batch.mjs','bridge.mjs','core.mjs','chrome.mjs'].map(f=>fs.readFileSync(path.join(root,f))).join('\n')).digest('hex');
const bootStamp=buildStamp();
const port=Number(process.env.OSHI_PORT||18745), host=`127.0.0.1:${port}`, origin=`http://${host}`;
const token=crypto.randomBytes(24).toString('hex');
const engine=new Engine(process.env.OSHI_DATA_DIR||path.join(root,'data'));
const batch=new Batch(process.env.OSHI_DATA_DIR||path.join(root,'data'),engine.journal);
const snapshot=()=>({...engine.snapshot(),batch:batch.snapshot(),runtime:{version,updateAvailable:buildStamp()!==bootStamp}});
const config=process.env.OSHI_PROFILES_FILE||path.join(process.env.APPDATA||'', 'ChromeManager','profiles.json');
const demo=process.env.OSHI_DEMO==='1';
const localChrome=new LocalChrome(path.join(process.env.LOCALAPPDATA||root,'OshiTaskAssistant'));
async function profiles() {
  if(demo)return [{id:'demo',name:'界面演示（不会连接浏览器）',debugPort:19001,running:false}];
  let raw=[];try{if(fs.existsSync(config))raw=JSON.parse(fs.readFileSync(config,'utf8').replace(/^\uFEFF/,''));}catch{engine.log('多开管理器配置无法读取，仍可使用普通 Chrome');}
  const rows=(Array.isArray(raw)?raw:[raw]).map(p=>({id:String(p.id),name:String(p.name),source:'manager',debugPort:Number(p.debugPort||19000+Number(p.id))}));
  const managed=await Promise.all(rows.map(async p=>{
    if(!Number.isInteger(p.debugPort)||p.debugPort<1024||p.debugPort>65535)return {...p,running:false};
    let running=false;
    try{const r=await fetch(`http://127.0.0.1:${p.debugPort}/json/version`,{signal:AbortSignal.timeout(1000)});const j=await r.json();running=Boolean(j.webSocketDebuggerUrl);}catch{}
    return {...p,running};
  }));
  return [...managed,...await localChrome.profiles(),...bridge.profiles()];
}
const resolveProfile=p=>p.source==='extension'?{...p,endpoint:bridge.endpoint(p.id)}:p;
const assets={'/':'index.html','/app.js':'app.js','/batch.js':'batch.js','/style.css':'style.css'};
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  try {
    if(req.headers.host!==host) return json(res,403,{error:'无效 Host'});
    if(req.headers.origin && req.headers.origin!==origin)return json(res,403,{error:'拒绝跨站访问'});
    const url=new URL(req.url,origin);
    if(req.method==='GET'&&url.pathname==='/api/health')return json(res,200,{app:'oshi-task-assistant',version,busy:engine.busy||batch.busy,updateAvailable:buildStamp()!==bootStamp});
    if(req.method==='GET'&&assets[url.pathname]) {
      let data=fs.readFileSync(path.join(root,'public',assets[url.pathname]),'utf8');
      if(url.pathname==='/')data=data.replace('__CSRF__',token);
      res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript; charset=utf-8':url.pathname.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');
      res.setHeader('Cache-Control','no-store');return res.end(data);
    }
    if(req.headers['x-oshi-token']!==token)return json(res,403,{error:'请重新打开工具页面'});
    if(req.method==='GET'&&url.pathname==='/api/state')return json(res,200,snapshot());
    if(req.method==='GET'&&url.pathname==='/api/profiles')return json(res,200,await profiles());
    if(req.method==='GET'&&url.pathname==='/api/extension/pairing')return json(res,200,{...bridge.pairing(),folder:path.join(root,'extension')});
    if(req.method!=='POST')return json(res,404,{error:'未找到接口'});
    if(!req.headers['content-type']?.startsWith('application/json'))return json(res,415,{error:'仅接受 JSON'});
    let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>128000)throw new Error('请求过大');}
    const body=JSON.parse(raw||'{}');
    if(url.pathname==='/api/shutdown') {
      if(engine.busy||batch.busy)throw new Error('请先停止队列，等待当前步骤结束后再关闭助手');
      json(res,200,{message:'助手服务已关闭，可以重新启动'});
      setTimeout(()=>process.exit(0),250);return;
    }
    if(demo)throw new Error('当前为界面演示，不执行浏览器操作');
    if(url.pathname.startsWith('/api/batch/')) {
      if(engine.busy)throw new Error('请先停止单环境任务，再使用并行队列');
      if(url.pathname==='/api/batch/prepare') {
        if(!Array.isArray(body.ids)||!body.ids.length)throw new Error('请选择环境');
        const available=await profiles();const selected=body.ids.map(id=>available.find(p=>p.id===id));
        if(engine.busy)throw new Error('请先停止单环境任务，再使用并行队列');
        if(selected.some(p=>!p))throw new Error('环境列表已变化，请刷新');batch.prepare(selected.map(resolveProfile),body.limit);
      } else if(url.pathname==='/api/batch/start')batch.start(body.plans,body.settings||{},body.limit);
      else if(url.pathname==='/api/batch/stop')batch.stop(body.id);
      else if(url.pathname==='/api/batch/approve')batch.approve(body.id,body.key,body.text);
      else return json(res,404,{error:'未找到接口'});
      return json(res,200,snapshot());
    }
    if(batch.busy)throw new Error('并行队列正在运行，请在多环境面板操作或先停止全部');
    switch(url.pathname) {
      case '/api/chrome/launch': {
        if(engine.busy)throw new Error('请先停止当前队列');
        const id=await localChrome.launch();return json(res,200,{id});
      }
      case '/api/chrome/add': {
        if(engine.busy)throw new Error('请先停止当前队列');
        const id=await localChrome.add(body.port);return json(res,200,{id});
      }
      case '/api/connect': {
        const p=(await profiles()).find(p=>p.id===String(body.id));if(!p?.running)throw new Error('该环境尚未启动，请启动对应 Chrome 后刷新环境');
        if(p.source==='chrome')await chromeEndpoint(p.debugPort);
        if(batch.busy)throw new Error('请先停止并行队列，再切换单环境');
        await engine.connect(resolveProfile(p));break;
      }
      case '/api/scan':await engine.scan();break;
      case '/api/start':engine.start(body.keys,body.settings||{},body.drafts||{});break;
      case '/api/approve':engine.approve(body.key,body.text);break;
      case '/api/stop':engine.stop();break;
      case '/api/recover':await engine.recover(body.key,body.url);break;
      case '/api/resume':engine.resumeOnly(body.key);break;
      default:return json(res,404,{error:'未找到接口'});
    }
    return json(res,200,snapshot());
  }catch(e){return json(res,400,{error:e.message});}
});
const bridge=new ExtensionBridge(server,host);
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`端口 ${port} 已被占用：请先关闭旧助手，或访问已运行的界面。`:e.message);process.exit(1);});
server.listen(port,'127.0.0.1',()=>console.log(`Oshi 助手已启动：${origin}\n退出请关闭此窗口或按 Ctrl+C。支持普通 Chrome 和多开管理器环境。`));
