import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Engine} from '../engine.mjs';
import {journalKey,taskKey} from '../core.mjs';

const makeTask=()=>{const t={title:'Comment',type:'reply',url:'https://x.com/oshi/status/100'};t.key=taskKey(t);return t;};
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oshi-engine-test-'));t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());assert(path.basename(dir).startsWith('oshi-engine-test-'));fs.rmSync(dir,{recursive:true,force:true});});
  const engine=new Engine(dir),task=makeTask(),counts={post:0,submit:0,like:0};
  engine.profile={id:'1',name:'test',account:'me'};engine.tasks=[task];
  engine.adapter={completed:async()=>false,openTarget:async()=> 'me',postText:async()=> 'hello',like:async()=>counts.like++,publish:async(_t,_text,before)=>{await before();counts.post++;return 'https://x.com/me/status/200';},verifyReply:async()=>{},submitReply:async()=>{counts.submit++;},cleanupTarget:async()=>{},scan:async()=>[]};
  return {engine,task,counts,key:journalKey('1','me',task)};
}
const settings={mode:'manual',text:'A specific reply',autoPublish:true,like:true};
test('successful queue journals real reply and completion in order',async t=>{
  const {engine,task,counts,key}=fixture(t);engine.start([task.key],settings);await engine.job;
  assert.equal(engine.status,'队列完成');assert.deepEqual(counts,{post:1,submit:1,like:1});assert.equal(engine.journal.get(key).stage,'done');assert.equal(engine.journal.get(key).replyUrl,'https://x.com/me/status/200');
});
test('submit failure followed by retry never posts or likes again',async t=>{
  const {engine,task,counts,key}=fixture(t);engine.adapter.submitReply=async()=>{counts.submit++;throw new Error('rejected');};engine.start([task.key],settings);await engine.job;
  assert.equal(engine.journal.get(key).stage,'posted');assert.equal(engine.status,'需处理');
  engine.adapter.submitReply=async()=>counts.submit++;engine.start([task.key],{mode:'auto'});await engine.job;
  assert.deepEqual(counts,{post:1,submit:2,like:1});assert.equal(engine.journal.get(key).stage,'done');
});
test('uncertain publication is not repeated after restarting engine',async t=>{
  const {engine,task,counts,key}=fixture(t);engine.adapter.publish=async(_t,_text,before)=>{await before();counts.post++;throw new Error('lost reply URL');};engine.start([task.key],settings);await engine.job;
  assert.equal(engine.journal.get(key).stage,'posting');engine.start([task.key],settings);await engine.job;assert.equal(counts.post,1);assert.equal(counts.submit,0);assert.match(engine.events.at(-1).message,/补填/);
});
test('account mismatch blocks social actions',async t=>{
  const {engine,task,counts}=fixture(t);engine.adapter.openTarget=async()=> 'someoneelse';engine.start([task.key],settings);await engine.job;assert.deepEqual(counts,{post:0,submit:0,like:0});assert.equal(engine.status,'需处理');
});
test('review waits for exact task and publishes edited text',async t=>{
  const {engine,task,counts,key}=fixture(t);engine.start([task.key],{...settings,autoPublish:false});
  for(let i=0;i<30&&!engine.pending;i++)await new Promise(r=>setTimeout(r,1));assert(engine.pending);assert.equal(counts.post,0);
  assert.throws(()=>engine.approve('wrong','text'));engine.approve(task.key,'Edited reply');await engine.job;assert.equal(engine.journal.get(key).text,'Edited reply');assert.equal(counts.post,1);
});
test('stop while awaiting review releases the queue without publishing',async t=>{
  const {engine,task,counts}=fixture(t);engine.start([task.key],{...settings,autoPublish:false});
  for(let i=0;i<30&&!engine.pending;i++)await new Promise(r=>setTimeout(r,1));engine.stop();await engine.job;assert.equal(engine.busy,false);assert.equal(engine.status,'已停止');assert.equal(counts.post,0);
});
test('unknown and unsupported tasks cannot be smuggled into the queue',t=>{
  const {engine}=fixture(t);assert.throws(()=>engine.start(['fake'],settings));engine.tasks=[{key:'m',type:'manual'}];assert.throws(()=>engine.start(['m'],settings));
});
test('resume button is restricted to saved links and never creates another reply',async t=>{
  const {engine,task,counts,key}=fixture(t);assert.throws(()=>engine.resumeOnly(task.key),/没有已保存/);
  engine.journal.set(key,{stage:'posted',replyUrl:'https://x.com/me/status/200',text:'old reply'});
  engine.resumeOnly(task.key);await engine.job;
  assert.deepEqual(counts,{post:0,submit:1,like:0});assert.equal(engine.journal.get(key).stage,'done');
});
test('failed continuation surfaces a persistent error while preserving reply URL',async t=>{
  const {engine,task,key}=fixture(t);engine.journal.set(key,{stage:'posted',replyUrl:'https://x.com/me/status/200',text:'old reply'});
  engine.adapter.submitReply=async()=>{throw new Error('button not visible');};engine.resumeOnly(task.key);await engine.job;
  assert.equal(engine.journal.get(key).replyUrl,'https://x.com/me/status/200');assert.equal(engine.journal.get(key).error,'button not visible');assert.match(engine.snapshot().lastError.message,/回复已发布/);
});
test('switch commits fresh environment and isolates records by profile and account',async t=>{
  const {engine,task,key}=fixture(t);const released=[];
  engine.journal.set(key,{profile:'1',account:'me',stage:'done'});
  engine.journal.set('other',{profile:'2',account:'second',stage:'posted',replyUrl:'https://x.com/second/status/201'});
  engine.journal.set('old-account',{profile:'2',account:'previous',stage:'posted'});
  engine.adapter.release=async()=>released.push('old');
  const candidate={connect:async()=>{},oshiAccount:async()=> 'second',scan:async()=>[{...task,title:'Second environment'}],release:async()=>released.push('new')};
  engine.makeAdapter=()=>candidate;await engine.connect({id:'2',name:'环境2',debugPort:19002});
  assert.equal(engine.adapter,candidate);assert.equal(engine.profile.account,'second');assert.equal(engine.tasks[0].title,'Second environment');assert.deepEqual(released,['old']);
  assert.equal(engine.snapshot().records.length,1);assert.equal(engine.snapshot().records[0].account,'second');assert.equal(engine.journal.get(key).stage,'done');
});
test('failed switch retains prior adapter, account, and task list',async t=>{
  const {engine,task}=fixture(t);const old=engine.adapter;let oldReleased=false,newReleased=false;
  old.release=async()=>{oldReleased=true;};
  engine.makeAdapter=()=>({connect:async()=>{},oshiAccount:async()=>{throw new Error('not signed in');},release:async()=>{newReleased=true;}});
  await assert.rejects(engine.connect({id:'2',name:'环境2',debugPort:19002}),/not signed in/);
  assert.equal(engine.adapter,old);assert.equal(engine.profile.account,'me');assert.equal(engine.tasks[0],task);assert.equal(oldReleased,false);assert.equal(newReleased,true);assert.equal(engine.busy,false);
});
test('running queue rejects switch without creating another connection',async t=>{
  const {engine}=fixture(t);engine.busy=true;engine.makeAdapter=()=>{throw new Error('must not create');};
  await assert.rejects(engine.connect({id:'2',debugPort:19002}),/任务正在运行/);
});

test('later task failure preserves prior completion, updates pending list, and exposes cause',async t=>{
  const {engine,task,key}=fixture(t);
  const next={title:'Follow on X',type:'follow',url:'https://x.com/target'};next.key=taskKey(next);
  engine.tasks.push(next);engine.adapter.follow=async()=>{throw new Error('target follow unavailable');};
  await assert.rejects(engine.run([task,next],{...settings,interval:0},{}),/target follow unavailable/);
  assert.equal(engine.journal.get(key).stage,'done');assert.deepEqual(engine.tasks.map(t=>t.key),[next.key]);
  engine.start([next.key],settings);await engine.job;
  assert.match(engine.lastError.message,/target follow unavailable/);
  assert.equal(engine.journal.get(journalKey('1','me',next)).type,'follow');
});
