import {ChromeSession} from './session.js';
let socket=null,heartbeat=null,windowId=null,status='未连接';const sessions=new Map();
const send=value=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(value));};
async function disconnect(){clearInterval(heartbeat);heartbeat=null;const old=socket;socket=null;old?.close();await Promise.all([...sessions.values()].map(s=>s.release()));sessions.clear();status='已断开';}
async function connect({address,token,name}){
  const url=new URL(address);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('助手地址必须是 http://127.0.0.1:端口');
  if(!/^[a-f0-9]{48}$/.test(token))throw new Error('请粘贴助手页面提供的完整连接码');
  await disconnect();const current=await chrome.windows.getCurrent();windowId=current.id;
  let {profileId}=await chrome.storage.local.get('profileId');if(!profileId){profileId=crypto.randomUUID();await chrome.storage.local.set({profileId});}
  await chrome.storage.local.set({address,name}); // The pairing secret is not persisted.
  url.protocol='ws:';url.pathname='/extension/socket';url.searchParams.set('token',token);url.searchParams.set('id',profileId);
  const ws=new WebSocket(url);socket=ws;status='正在连接';
  ws.onmessage=async event=>{let msg;try{msg=JSON.parse(event.data);}catch{return;}
    if(msg.type==='release'){const session=sessions.get(msg.client);sessions.delete(msg.client);await session?.release();return;}
    if(msg.type!=='command'||!msg.client)return;
    let session=sessions.get(msg.client);if(!session){session=new ChromeSession(chrome,message=>send({client:msg.client,message}),windowId);sessions.set(msg.client,session);}
    const {id,sessionId}=msg.message;try{const result=await session.command(msg.message);send({client:msg.client,message:{id,sessionId,result}});}catch(e){send({client:msg.client,message:{id,sessionId,error:{message:e.message}}});}
  };
  ws.onclose=()=>{if(socket===ws){status='连接已断开，请重新连接';socket=null;clearInterval(heartbeat);heartbeat=null;void Promise.all([...sessions.values()].map(s=>s.release()));sessions.clear();}};
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(new Error('助手未响应，请先启动最新版助手'));},8000);ws.onopen=()=>{clearTimeout(timer);status='已连接';send({type:'hello',name:name||'已登录 Chrome（扩展）'});heartbeat=setInterval(()=>send({type:'ping'}),20000);resolve();};ws.onerror=()=>{clearTimeout(timer);reject(new Error('连接失败，请检查助手地址及连接码'));};});
}
chrome.debugger.onEvent.addListener((source,method,params)=>{for(const session of sessions.values())session.event(source,method,params);});
chrome.debugger.onDetach.addListener(source=>{for(const session of sessions.values())session.detached(source.tabId);});
chrome.tabs.onRemoved.addListener(tabId=>{for(const session of sessions.values())session.detached(tabId);});
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.url)for(const session of sessions.values())void session.navigated(tabId,change.url);});
chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
  if(sender.id!==chrome.runtime.id)return;
  (async()=>{if(msg.type==='connect')await connect(msg);else if(msg.type==='disconnect')await disconnect();return {status,connected:socket?.readyState===WebSocket.OPEN};})().then(respond,e=>respond({error:e.message}));return true;
});
