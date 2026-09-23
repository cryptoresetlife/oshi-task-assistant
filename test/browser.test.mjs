import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserAdapter} from '../browser.mjs';

function followPage(buttons,{load,confirm=true,url='https://x.com/mangayomucom'}={}) {
  const clicks=[];
  class Locator {
    constructor(predicate=()=>true){this.predicate=predicate;}
    rows(){return buttons.filter(this.predicate);}
    getByRole(_role,{name}){return new Locator(b=>this.predicate(b)&&name.test(b.label));}
    locator(){return new Locator(b=>this.predicate(b)&&/-(?:un)?follow$/.test(b.id));}
    and(other){return new Locator(b=>this.predicate(b)&&other.predicate(b));}
    filter(){return new Locator(b=>this.predicate(b)&&b.visible!==false);}
    getByTestId(id){return new Locator(b=>this.predicate(b)&&b.id===id);}
    first(){return this;}
    async waitFor(){if(!this.rows().length&&load){load(buttons);load=null;}if(!this.rows().length)throw new Error('timeout');}
    async count(){return this.rows().length;}
    async getAttribute(){return this.rows()[0].id;}
    async click(){const row=this.rows()[0];clicks.push(row.id);if(confirm)row.id=row.id.replace(/-follow$/,'-unfollow');}
  }
  const adapter=new BrowserAdapter(()=>{},()=>{});adapter.guard=async()=>{};
  adapter.x={url:()=>url,getByTestId:()=>new Locator()};return {adapter,clicks};
}
const followTask={type:'follow',url:'https://x.com/mangayomucom'};

function articleControls(buttons) {
  const clicks=[];
  class Locator {
    constructor(predicate){this.predicate=predicate;}
    rows(){return buttons.filter(this.predicate);}
    filter({visible}){return new Locator(b=>this.predicate(b)&&(!visible||b.visible!==false));}
    or(other){return new Locator(b=>this.predicate(b)||other.predicate(b));}
    first(){return this;}
    async waitFor(){assert(this.rows().length>0,'expected control state');}
    async count(){return this.rows().length;}
    async click(){assert.equal(this.rows().length,1,'never choose arbitrary duplicate');const b=this.rows()[0];clicks.push(b.name);if(b.id==='like')b.id='unlike';if(b.id==='retweet')b.id='unretweet';}
  }
  const post={locator(selector){const id=selector.match(/button\[data-testid="([^"]+)"\]/)?.[1];assert(id);assert(selector.includes(':not([data-testid="twitterArticleReadView"] *)'));assert(selector.includes(':not([data-testid="quoteTweet"] *)'));return new Locator(b=>b.id===id&&!b.article&&!b.quote);}};
  const adapter=new BrowserAdapter(()=>{},()=>{});adapter.guard=async()=>{};adapter.targetPost=async()=>post;
  return {adapter,post,clicks};
}

test('article duplicate toolbar is excluded from likes; a second call never unlikes',async()=>{
  const {adapter,clicks}=articleControls([{id:'like',name:'article',article:true},{id:'like',name:'outer'},{id:'like',name:'hidden',visible:false}]);
  await adapter.like({});await adapter.like({});assert.deepEqual(clicks,['outer']);
});
test('article unlike state cannot masquerade as a liked outer tweet',async()=>{
  const {adapter,clicks}=articleControls([{id:'unlike',name:'article',article:true},{id:'like',name:'outer'}]);
  await adapter.like({});assert.deepEqual(clicks,['outer']);
});
test('two remaining visible outer controls stop without clicking',async()=>{
  const {adapter,clicks}=articleControls([{id:'like',name:'outer1'},{id:'like',name:'outer2'}]);
  await assert.rejects(adapter.like({}),/不唯一/);assert.deepEqual(clicks,[]);
});
test('reply and repost share the outer-control boundary, excluding quotes and article controls',async()=>{
  for(const id of ['reply','retweet']){
    const {adapter,post,clicks}=articleControls([{id,name:'quote',quote:true},{id,name:'article',article:true},{id,name:'outer'}]);
    const control=await adapter.actionControl(post,id,id==='retweet'?'unretweet':undefined);await control.click();assert.deepEqual(clicks,['outer']);
  }
});
test('follow waits for target and ignores recommendation buttons and handle prefixes',async()=>{
  const {adapter,clicks}=followPage([{id:'2-follow',label:'关注 @other'},{id:'3-follow',label:'Follow @mangayomucom2'}],{load:rows=>rows.push({id:'1998595899241689088-follow',label:'关注 @mangayomucom'})});
  await adapter.follow(followTask);assert.deepEqual(clicks,['1998595899241689088-follow']);
});
test('already following target never clicks unfollow even when recommendations are unfollowed',async()=>{
  const {adapter,clicks}=followPage([{id:'2-follow',label:'Follow @other'},{id:'1-unfollow',label:'Following @MANGAYOMUCOM'}]);
  await adapter.follow(followTask);assert.deepEqual(clicks,[]);
});
test('ambiguous target or wrong destination blocks all follow clicks',async()=>{
  const ambiguous=followPage([{id:'1-follow',label:'关注 @mangayomucom'},{id:'1-follow',label:'Follow @mangayomucom'}]);
  await assert.rejects(ambiguous.adapter.follow(followTask),/不唯一/);assert.deepEqual(ambiguous.clicks,[]);
  const wrong=followPage([{id:'1-follow',label:'Follow @mangayomucom'}],{url:'https://x.com/other'});
  await assert.rejects(wrong.adapter.follow(followTask),/不一致/);assert.deepEqual(wrong.clicks,[]);
});
test('unconfirmed follow is reported as failure without clicking again',async()=>{
  const {adapter,clicks}=followPage([{id:'1-follow',label:'Follow @mangayomucom'}],{confirm:false});
  await assert.rejects(adapter.follow(followTask),/尚未确认/);assert.equal(clicks.length,1);
});

test('task remains actionable when Chrome translates its title after lookup',async()=>{
  const dom={href:'https://x.com/oshi/status/100',title:'Comment',buttons:'Submit reply URL'};
  class Locator {
    constructor(predicate=()=>true){this.predicate=predicate;}
    async evaluateAll(){return [{...dom}];}
    filter({has}){return new Locator(row=>this.predicate(row)&&has.predicate(row));}
    async count(){return this.predicate(dom)?1:0;}
    async isVisible(){return this.predicate(dom);}
  }
  const adapter=new BrowserAdapter(()=>{},()=>{});
  adapter.oshi={locator:selector=>selector.startsWith('section')?new Locator():new Locator(row=>selector===`a[href=${JSON.stringify(row.href)}]`),getByRole:(_role,{name})=>new Locator(row=>typeof name==='string'?row.title===name:name.test(row.title))};
  const card=await adapter.card({type:'reply',url:dom.href});
  dom.title='评论';dom.buttons='提交回复 URL';
  assert.equal(await card.isVisible(),true,'Changing the translated label must not invalidate an otherwise identical task');
});
test('guard activates the target page before checking page state',async()=>{
  const steps=[],adapter=new BrowserAdapter(()=>steps.push('log'),()=>steps.push('check'));
  await adapter.guard({isClosed:()=>false,bringToFront:async()=>steps.push('activate'),url:()=>{steps.push('read');return 'https://studio.oshi-labs.com/?tab=tasks';},locator:()=>({count:async()=>0})});
  assert(steps.indexOf('activate')<steps.indexOf('read'));
});
test('release closes only the assistant task tab and disconnects CDP, retaining X pages',async()=>{
  const called=[],adapter=new BrowserAdapter(()=>{},()=>{});
  adapter.oshi={isClosed:()=>false,close:async()=>called.push('oshi')};
  adapter.x={close:async()=>called.push('x')};
  adapter.browser={isConnected:()=>true,close:async()=>called.push('disconnect')};adapter.account='first';adapter.expectedAccount='first';
  await adapter.release();assert.deepEqual(called,['oshi','disconnect']);assert.equal(adapter.browser,null);assert.equal(adapter.expectedAccount,null);
});

function gatedReport({enabled=false,unlock=true,completed=true,href='https://x.com/example'}={}) {
  const steps=[],adapter=new BrowserAdapter(m=>steps.push(m),()=>{},'ws://fixture');
  adapter.guard=async()=>{};adapter.oshi={};let reported=false;
  const button={count:async()=>1,isEnabled:async()=>enabled,click:async()=>{assert(enabled);steps.push('report');reported=true;}};
  const entry={count:async()=>1,getAttribute:async()=>href,click:async()=>{steps.push('entry');if(unlock)enabled=true;}};
  const card={locator:selector=>selector==='button'?button:selector==='a[target="_blank"]'?entry:{waitFor:async()=>{if(!enabled)throw new Error('timeout');}}};
  adapter.card=async(_task,done)=>done?(reported&&completed?{}:null):card;
  return {adapter,steps};
}

test('extension report clicks the official entry before reporting a confirmed action',async()=>{
  const {adapter,steps}=gatedReport();await adapter.submitSimple({type:'follow',url:'https://x.com/example'});
  assert(steps.indexOf('entry')<steps.indexOf('report'));assert(steps.includes('report'));
});

test('enabled official report does not open another task entry',async()=>{
  const {adapter,steps}=gatedReport({enabled:true});await adapter.submitSimple({type:'follow',url:'https://x.com/example'});
  assert.deepEqual(steps,['report']);
});

test('extension never forces a report button that remains disabled',async()=>{
  const {adapter,steps}=gatedReport({unlock:false});await assert.rejects(adapter.submitSimple({type:'follow',url:'https://x.com/example'}),/仍不可用/);
  assert(!steps.includes('report'));
});

test('extension refuses a mismatching official task entry without opening it',async()=>{
  const {adapter,steps}=gatedReport({href:'https://x.com/other'});await assert.rejects(adapter.submitSimple({type:'follow',url:'https://x.com/example'}),/不一致/);
  assert.deepEqual(steps,[]);
});
