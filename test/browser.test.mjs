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
