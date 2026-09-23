import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('lost service invalidates frozen progress and reconnect restores control states',()=>{
  const elements=new Map(),controls=[{disabled:false},{disabled:true}];
  const get=id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);};
  const card={status:{textContent:'正在运行'}},runtimeNote={};
  const context=vm.createContext({$:get,runtimeNote,batchCards:new Map([['one',card]]),
    document:{querySelectorAll:()=>controls},showError:message=>{get('error').textContent=message;get('error').hidden=false;}});
  const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const functions=source.slice(source.indexOf('const disconnectedControls='),source.indexOf('let polling=false;'));
  const ui=vm.runInContext(functions+'\n({serviceDisconnected,serviceReconnected})',context);
  ui.serviceDisconnected();ui.serviceDisconnected();
  assert.equal(get('status').textContent,'服务未连接');
  assert.match(get('batch-status').textContent,/最后收到/);
  assert.match(card.status.textContent,/状态未知/);
  assert.ok(controls.every(c=>c.disabled));assert.equal(get('error').hidden,false);
  ui.serviceReconnected();
  assert.deepEqual(controls.map(c=>c.disabled),[false,true]);assert.equal(get('error').hidden,true);
  ui.serviceDisconnected();get('error').textContent='another error';ui.serviceReconnected();
  assert.equal(get('error').hidden,false);
});
