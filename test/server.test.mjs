import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('service exposes its runtime version and requires authentication to stop',async t=>{
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oshi-server-test-'));
  const root=fileURLToPath(new URL('..',import.meta.url));
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,OSHI_DEMO:'1',OSHI_PORT:String(port),OSHI_DATA_DIR:dir,LOCALAPPDATA:dir}});
  const exited=once(child,'exit');let output='';child.stderr.on('data',data=>output+=data);
  t.after(async()=>{if(child.exitCode===null){child.kill();await exited;}assert.equal(path.dirname(dir),os.tmpdir());assert(path.basename(dir).startsWith('oshi-server-test-'));fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;
  let health;
  for(let attempt=0;attempt<100;attempt++){
    try{health=await (await fetch(base+'/api/health')).json();break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert(health,output||'server failed to start');
  assert.deepEqual(Object.keys(health).sort(),['app','busy','updateAvailable','version']);
  assert.equal(health.app,'oshi-task-assistant');assert.equal(health.updateAvailable,false);
  assert.equal(health.version,JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version);
  assert.equal((await fetch(base+'/api/state')).status,403);
  assert.equal((await fetch(base+'/api/shutdown',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  const html=await (await fetch(base)).text();const token=html.match(/name="oshi-token" content="([a-f0-9]+)"/)[1];
  const headers={'Content-Type':'application/json','X-Oshi-Token':token};
  const state=await (await fetch(base+'/api/state',{headers})).json();
  assert.equal(state.runtime.version,health.version);
  assert.equal((await fetch(base+'/api/shutdown',{method:'POST',headers,body:'{}'})).status,200);
  const outcome=await Promise.race([exited,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('shutdown did not exit')),5000);timer.unref();})]);
  assert.equal(outcome[0],0);
});
