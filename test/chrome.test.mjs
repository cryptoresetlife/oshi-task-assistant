import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {LocalChrome,chromePort,chromeEndpoint} from '../chrome.mjs';

const response=(port=19222,id='test-browser')=>({ok:true,json:async()=>({Browser:'Chrome/140.0',webSocketDebuggerUrl:`ws://127.0.0.1:${port}/devtools/browser/${id}`})});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oshi-chrome-test-'));t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());assert(path.basename(dir).startsWith('oshi-chrome-test-'));fs.rmSync(dir,{recursive:true,force:true});});return dir;}
test('custom Chrome rejects URLs, remote endpoints and invalid ports',async()=>{
  for(const v of [0,1023,65536,'9222/path','http://remote:9222','1e4',null])assert.throws(()=>chromePort(v));
  let called;await chromeEndpoint('9222',async(url)=>{called=url;return response(9222);});assert.equal(called,'http://127.0.0.1:9222/json/version');
  for(const ws of ['ws://remote:9222/devtools/browser/a','ws://127.0.0.1:9333/devtools/browser/a','wss://127.0.0.1:9222/devtools/browser/a'])await assert.rejects(chromeEndpoint(9222,async()=>({ok:true,json:async()=>({Browser:'Chrome/140',webSocketDebuggerUrl:ws})})),/有效的本机/);
});
test('ordinary Chrome remains available without a manager or prior settings',async t=>{
  const manager=new LocalChrome(fixture(t));const entries=await manager.profiles();
  assert.equal(entries.length,1);assert.equal(entries[0].id,'local-chrome');assert.equal(entries[0].running,false);
});
test('saved custom connections survive restart and remain isolated from numeric manager IDs',async t=>{
  const root=fixture(t),fetcher=async()=>response();const manager=new LocalChrome(root,{fetcher});
  assert.equal(await manager.add(19222),'chrome:19222');await manager.add(19222);
  const entries=await new LocalChrome(root,{fetcher}).profiles();assert.equal(entries.length,2);assert.equal(entries[1].running,true);
});
test('stale port files never identify a different Chrome instance as the owned browser',async t=>{
  const manager=new LocalChrome(fixture(t),{fetcher:async()=>response(19222,'different')});fs.mkdirSync(manager.dir,{recursive:true});fs.writeFileSync(path.join(manager.dir,'DevToolsActivePort'),'19222\n/devtools/browser/original\n');
  assert.equal(await manager.own(),null);
});
test('launch uses a persistent isolated directory and reuses the same browser on the next launch',async t=>{
  const root=fixture(t);let args,launches=0;
  const manager=new LocalChrome(root,{fetcher:async()=>response(),exists:p=>p.endsWith('chrome.exe')||fs.existsSync(p),spawnProcess:(_file,options)=>{
    launches++;args=options;fs.writeFileSync(path.join(manager.dir,'DevToolsActivePort'),'19222\n/devtools/browser/test-browser\n');const process=new EventEmitter();process.unref=()=>{};return process;
  }});
  assert.equal(await manager.launch(),'local-chrome');assert.equal(await manager.launch(),'local-chrome');assert.equal(launches,1);
  assert(args.includes(`--user-data-dir=${path.join(root,'Chrome')}`));assert(args.includes('--remote-debugging-address=127.0.0.1'));assert(args.includes('--remote-debugging-port=0'));
  assert.equal((await manager.profiles())[0].debugPort,19222);
});
