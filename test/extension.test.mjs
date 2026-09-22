import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {chromium} from 'playwright-core';
import {ExtensionBridge} from '../bridge.mjs';
import {ChromeSession,allowedUrl} from '../extension/session.js';

function chromeFixture(){
  let next=100;const tabs=new Map(),calls=[];let dispatch=()=>{};
  const api={tabs:{
    create:async options=>{const tab={id:++next,...options};tabs.set(tab.id,tab);calls.push(['create',options]);return tab;},
    get:async id=>{assert(tabs.has(id));return tabs.get(id);},remove:async id=>{tabs.delete(id);calls.push(['remove',id]);}
  },debugger:{attach:async target=>{calls.push(['attach',target.tabId]);},detach:async target=>{calls.push(['detach',target.tabId]);},sendCommand:async(source,method,params={})=>{
    calls.push([method,source.tabId,source.sessionId]);const id='target-'+source.tabId;
    if(method==='Target.getTargetInfo')return {targetInfo:{targetId:id,type:'page',title:'Work tab',url:tabs.get(source.tabId).url,attached:true,browserContextId:'real-default'}};
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id,loaderId:'loader',url:'about:blank',securityOrigin:':',mimeType:'text/html'}}};
    if(method==='Runtime.enable')dispatch(source,'Runtime.executionContextCreated',{context:{id:1,origin:':',name:'',auxData:{isDefault:true,type:'default',frameId:id}}});
    if(method==='Page.createIsolatedWorld'){dispatch(source,'Runtime.executionContextCreated',{context:{id:2,origin:':',name:params.worldName,auxData:{isDefault:false,type:'isolated',frameId:id}}});return {executionContextId:2};}
    if(method==='Page.addScriptToEvaluateOnNewDocument')return {identifier:'script'};
    return {};
  }}};return {api,tabs,calls,setDispatch:fn=>{dispatch=fn;}};
}
test('extension controls only its own work tabs and rejects other sites and credential commands',async()=>{
  const f=chromeFixture(),events=[],s=new ChromeSession(f.api,m=>events.push(m),42);
  await assert.rejects(s.command({method:'Target.createTarget',params:{url:'https://example.com'}}),/仅允许/);assert.equal(f.calls.length,0);
  await s.command({method:'Target.createTarget',params:{url:'about:blank'}});
  const row=[...s.tabs.values()][0];assert.equal(f.calls[0][1].windowId,42);assert.equal(events[0].params.targetInfo.browserContextId,'real-default');
  await assert.rejects(s.command({method:'Runtime.enable',sessionId:'unowned'}),/未授权/);
  await assert.rejects(s.command({method:'Network.getCookies',sessionId:row.sessionId}),/范围/);
  await assert.rejects(s.command({method:'Page.navigate',sessionId:row.sessionId,params:{url:'https://example.com'}}),/禁止/);
  f.tabs.get(row.tabId).url='https://example.com';await assert.rejects(s.command({method:'Runtime.enable',sessionId:row.sessionId}),/离开/);
  await s.release();assert(f.calls.some(c=>c[0]==='detach'));assert(!f.calls.some(c=>c[0]==='remove'),'disconnect retains tabs for manual review');
});
test('child frame events and commands stay inside the owning work tab',async()=>{
  const f=chromeFixture(),events=[],s=new ChromeSession(f.api,m=>events.push(m));await s.create('https://x.com/home');const row=[...s.tabs.values()][0];
  s.event({tabId:row.tabId},'Target.attachedToTarget',{sessionId:'child',targetInfo:{type:'iframe'}});
  await s.command({sessionId:'child',method:'Runtime.enable'});assert(f.calls.some(c=>c[0]==='Runtime.enable'&&c[2]==='child'));
  const before=events.length;s.event({tabId:999},'Runtime.consoleAPICalled',{});assert.equal(events.length,before);
  s.detached(row.tabId);await assert.rejects(s.command({sessionId:'child',method:'Runtime.enable'}),/未授权/);
});
test('URL boundary accepts only exact site origins',()=>{
  for(const url of ['about:blank','https://x.com/home','https://studio.oshi-labs.com/?tab=tasks'])assert(allowedUrl(url));
  for(const url of ['https://x.com.evil.test','https://x.com@evil.test','https://u:p@x.com','http://x.com','file:///tmp/a','chrome://settings','https://x.com:9000'])assert(!allowedUrl(url));
});
test('authenticated relay supports real Playwright CDP initialization, isolated clients and page lifecycle',async t=>{
  const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const host='127.0.0.1:'+server.address().port,bridge=new ExtensionBridge(server,host);
  t.after(()=>{for(const ws of bridge.wss.clients)ws.terminate();bridge.close();server.close();});
  const rejected=new WebSocket(`ws://${host}/extension/socket?token=bad&id=test-profile-123456`,{origin:'chrome-extension://'+'a'.repeat(32)});
  await once(rejected,'error');assert.equal(bridge.profiles().length,0);
  const ext=new WebSocket(`ws://${host}/extension/socket?token=${bridge.pairToken}&id=test-profile-123456`,{origin:'chrome-extension://'+'a'.repeat(32)});await once(ext,'open');
  const sessions=new Map(),f=chromeFixture();f.setDispatch((source,method,params)=>{for(const s of sessions.values())s.event(source,method,params);});
  ext.on('message',async data=>{const msg=JSON.parse(data);if(msg.type==='release'){await sessions.get(msg.client)?.release();sessions.delete(msg.client);return;}if(msg.type!=='command')return;let s=sessions.get(msg.client);if(!s){s=new ChromeSession(f.api,message=>ext.send(JSON.stringify({client:msg.client,message})),42);sessions.set(msg.client,s);}const {id,sessionId}=msg.message;try{const result=await s.command(msg.message);ext.send(JSON.stringify({client:msg.client,message:{id,sessionId,result}}));}catch(e){ext.send(JSON.stringify({client:msg.client,message:{id,sessionId,error:{message:e.message}}}));}});
  const url=bridge.endpoint('extension:test-profile-123456');const b1=await chromium.connectOverCDP(url,{noDefaults:true,timeout:5000}),b2=await chromium.connectOverCDP(url,{noDefaults:true,timeout:5000});
  const p1=await b1.contexts()[0].newPage(),p2=await b2.contexts()[0].newPage();assert.equal(p1.url(),'about:blank');assert.equal(b1.contexts()[0].pages().length,1);assert.equal(b2.contexts()[0].pages().length,1);
  assert(!JSON.stringify(bridge.profiles()).includes(bridge.secret));assert.equal(f.tabs.size,2);
  await p1.close();assert.equal(f.tabs.size,1);await b1.close();assert.equal(b2.isConnected(),true);await p2.close();await b2.close();ext.close();
});
