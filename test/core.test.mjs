import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {xUrl,validateReply,validateReplyUrl,taskType,taskKey,Journal,nextAction,endpointUrl,generateReply} from '../core.mjs';

const target='https://x.com/oshi/status/2101891857659973969';
test('canonical X URL discards tracking; rejects impostor origins and non-post paths',()=>{
  assert.equal(xUrl('https://twitter.com/Oshi/status/123?s=20').url,'https://x.com/Oshi/status/123');
  for(const u of ['javascript:alert(1)','https://x.com.evil.test/a/status/12','http://x.com/a/status/12','https://x.com@evil.test/a/status/12','https://x.com/i/status/12','https://x.com/abc?next=/status/12'])assert.throws(()=>xUrl(u,true));
});
test('reply URL must belong to account and differ from original',()=>{
  assert.equal(validateReplyUrl('https://x.com/Me/status/42?s=20','me',target),'https://x.com/Me/status/42');
  assert.throws(()=>validateReplyUrl(target,'me',target));
  assert.throws(()=>validateReplyUrl(target,'oshi',target));
  assert.throws(()=>validateReplyUrl('https://x.com/me','me',target));
});
test('reply validation rejects empty and long unicode text',()=>{
  assert.equal(validateReply('  具体的回复 🙂  '),'具体的回复 🙂');
  assert.throws(()=>validateReply(' '));assert.throws(()=>validateReply('中'.repeat(141)));
});
test('task classification preserves action identity and excludes unsupported sites',()=>{
  assert.equal(taskType('评论','提交回复 URL',target),'reply');
  assert.equal(taskType('Comment','Completed',target),'reply');
  assert.equal(taskType('Follow on X','I have followed','https://x.com/oshi'),'follow');
  assert.equal(taskType('フォロー','Follow','https://instagram.com/oshi'),'manual');
  assert.equal(taskType('里ツイート','转发',target),'repost');
  assert.notEqual(taskKey({type:'reply',url:target}),taskKey({type:'like',url:target}));
});
test('journal survives restart and never retries an uncertain publication',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oshi-test-'));
  try{const j=new Journal(dir);j.set('a',{stage:'posting',text:'test'});assert.equal(nextAction(new Journal(dir).get('a')),'recover');j.set('a',{replyUrl:'https://x.com/me/status/42',stage:'posted'});assert.equal(nextAction(new Journal(dir).get('a')),'submit');j.set('a',{stage:'done'});assert.equal(nextAction(j.get('a')),'skip');assert.equal(nextAction(j.get('missing')),'publish');}
  finally{assert.equal(path.dirname(dir),os.tmpdir());assert(path.basename(dir).startsWith('oshi-test-'));fs.rmSync(dir,{recursive:true,force:true});}
});
test('model transport requires secure endpoint and never includes key in errors',async()=>{
  assert.equal(endpointUrl('http://127.0.0.1:1234/v1/chat/completions'),'http://127.0.0.1:1234/v1/chat/completions');
  assert.throws(()=>endpointUrl('http://api.example.com/v1/chat/completions'));assert.throws(()=>endpointUrl('https://api.example.com/?key=x'));
  const original=global.fetch;
  try{let sent;global.fetch=async(url,args)=>{sent=JSON.parse(args.body);assert.equal(args.redirect,'error');return {ok:true,json:async()=>({choices:[{message:{content:'The search filter looks useful.'}}]})};};
    assert.equal(await generateReply({endpoint:'https://example.com/v1/chat/completions',model:'test',apiKey:'secret'},'A new search filter',new AbortController().signal),'The search filter looks useful.');assert.match(sent.messages[0].content,/untrusted/);assert(!JSON.stringify(sent).includes('secret'));
    global.fetch=async()=>({ok:false,status:401});await assert.rejects(generateReply({endpoint:'https://example.com/v1/chat/completions',model:'test',apiKey:'secret'},'Post',new AbortController().signal),/HTTP 401/);
  }finally{global.fetch=original;}
});
