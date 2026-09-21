import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Batch,concurrency} from '../batch.mjs';
import {Engine} from '../engine.mjs';
import {Journal,taskKey} from '../core.mjs';

const settings={mode:'manual',text:'A considered reply',autoPublish:false};
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('condition timed out');}
async function fixture(t,count=4,accounts){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oshi-batch-test-'));
  t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());assert(path.basename(dir).startsWith('oshi-batch-test-'));fs.rmSync(dir,{recursive:true,force:true});});
  const journal=new Journal(dir),published=[],connected=[];let engineIndex=0;
  const task={title:'Comment',type:'reply',url:'https://x.com/oshi/status/100'};task.key=taskKey(task);
  const batch=new Batch(dir,journal,()=>{
    const id=String(++engineIndex),account=accounts?.[Number(id)-1]||'user'+id;let done=false;
    return new Engine(dir,()=>({
      connect:async()=>{connected.push(id);},oshiAccount:async()=>account,scan:async()=>done?[]:[{...task}],release:async()=>{},
      completed:async()=>false,openTarget:async()=>account,publish:async(_task,text,before)=>{await before();published.push({id,text});return `https://x.com/${account}/status/200`;},
      verifyReply:async()=>{},submitReply:async()=>{done=true;},cleanupTarget:async()=>{}
    }));
  });
  t.after(async()=>{batch.stop();await batch.job;});
  const sources=Array.from({length:count},(_,i)=>({id:String(i+1),name:'Environment '+(i+1),debugPort:19001+i,running:true}));
  batch.prepare(sources);await batch.job;
  const plans=sources.map(p=>({id:p.id,keys:[task.key]}));
  return {batch,journal,published,connected,task,plans,sources,dir};
}

test('default three slots hold reviews; fourth starts only after a slot completes; journal retains all accounts',async t=>{
  const {batch,journal,published,plans,task,dir}=await fixture(t);
  journal.set('existing',{stage:'done'});batch.start(plans,settings);
  await until(()=>batch.entries.slice(0,3).every(e=>e.engine.pending));
  assert.equal(batch.entries[3].stage,'等待运行');assert.equal(published.length,0);
  batch.approve('1',task.key,'First edited reply');await until(()=>batch.entries[3].engine.pending);
  for(const id of ['2','3','4'])batch.approve(id,task.key,'Reply '+id);
  await batch.job;assert.equal(batch.phase,'并行队列完成');assert.equal(published.length,4);
  const disk=JSON.parse(fs.readFileSync(path.join(dir,'history.json'),'utf8'));
  assert.equal(Object.keys(disk).length,5);assert.equal(disk.existing.stage,'done');
  for(const e of batch.entries){assert.equal(e.engine.journal,journal);assert.equal(e.engine.snapshot().records.length,1);assert.equal(e.engine.snapshot().records[0].stage,'done');}
});

test('stop all cancels pending reviews and never starts queued environments',async t=>{
  const {batch,plans,published}=await fixture(t);batch.start(plans,settings,2);
  await until(()=>batch.entries.slice(0,2).every(e=>e.engine.pending));batch.stop();await batch.job;
  assert.equal(batch.busy,false);assert.equal(published.length,0);assert.equal(batch.phase,'已停止');
  assert(batch.entries.every(e=>e.disabled));assert(batch.entries.slice(2).every(e=>e.stage==='已停止'&&!e.engine.profile?.current));
});

test('one failed worker and one stopped worker leave other workers running',async t=>{
  const {batch,plans,task,published}=await fixture(t);
  batch.entries[0].engine.adapter.openTarget=async()=>{throw new Error('test connection failed');};
  batch.start(plans,settings,3);await until(()=>batch.entries[3].engine.pending);
  batch.stop('2');batch.approve('3',task.key,'Third');batch.approve('4',task.key,'Fourth');await batch.job;
  assert.deepEqual(published.map(p=>p.id).sort(),['3','4']);assert.match(batch.entries[0].error,/test connection failed/);assert.equal(batch.entries[1].stage,'已停止');
  assert.equal(batch.phase,'已结束，部分环境需处理');
});

test('all plans validate before any publication and configuration secrets stay out of snapshots',async t=>{
  const {batch,plans,published}=await fixture(t,2);
  assert.throws(()=>batch.start([plans[0],{id:'2',keys:['missing']}],{...settings,autoPublish:true}),/未识别/);
  assert.equal(batch.busy,false);assert.equal(published.length,0);
  assert.throws(()=>batch.start(plans,{mode:'auto',endpoint:''}),/模型接口/);
  batch.start(plans,{...settings,apiKey:'secret-fixture-value'});await until(()=>batch.entries.every(e=>e.engine.pending));
  assert(!JSON.stringify(batch.snapshot()).includes('secret-fixture-value'));
  assert.throws(()=>batch.approve('missing','key','Reply'),/不可确认/);
  assert.throws(()=>batch.approve('1','wrong','Reply'),/没有对应/);assert.equal(published.length,0);
});

test('duplicate account detection is case insensitive and duplicate ports are rejected',async t=>{
  const {batch,sources,plans}=await fixture(t,2,['SameUser','sameuser']);
  assert.equal(batch.entries[1].disabled,true);assert.equal(batch.entries[1].stage,'账号重复');
  assert.throws(()=>batch.start(plans,settings),/重新扫描/);
  assert.throws(()=>batch.prepare([sources[0],{...sources[1],debugPort:sources[0].debugPort}]),/重复/);
  for(const v of [0,11,1.5,'bad'])assert.throws(()=>concurrency(v));assert.equal(concurrency(10),10);
});

test('parallel scan enforces limit and stop prevents queued connections',async t=>{
  const {batch,sources}=await fixture(t);let active=0,max=0,calls=0;const releases=[];
  batch.makeEngine=()=>new Engine(batch.journal.file.replace(/[/\\]history.json$/,''),()=>({
    connect:async()=>{calls++;active++;max=Math.max(max,active);await new Promise(r=>releases.push(r));active--;},
    oshiAccount:async()=> 'scanuser',scan:async()=>[],release:async()=>{}
  }));
  batch.prepare(sources,2);await until(()=>calls===2);batch.stop();releases.forEach(r=>r());await batch.job;
  assert.equal(max,2);assert.equal(calls,2);assert.equal(batch.phase,'已停止');
});
