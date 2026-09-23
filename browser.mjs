import { chromium } from 'playwright-core';
import { xUrl, taskType, taskKey, validateReplyUrl } from './core.mjs';

const ROOT='https://studio.oshi-labs.com/';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const taskIssue=message=>Object.assign(new Error(message),{code:'TASK_NEEDS_ATTENTION'});
export class BrowserAdapter {
  constructor(log, check, endpoint=null) { this.log=log; this.check=check; this.endpoint=endpoint; }
  async connect(port) {
    if (!this.endpoint&&(!Number.isInteger(port) || port<1024 || port>65535)) throw new Error('浏览器端口无效');
    if (this.browser?.isConnected() && this.port!==port) await this.release();
    if (!this.browser?.isConnected()) this.browser=await chromium.connectOverCDP(this.endpoint||`http://127.0.0.1:${port}`,{timeout:15000,noDefaults:true});
    this.port=port; this.context=this.browser.contexts()[0];
    if (!this.context) throw new Error('没有可用的 Chrome 上下文');
    this.context.setDefaultTimeout(30000);
    this.context.setDefaultNavigationTimeout(45000);
    this.oshi = await this.context.newPage();
    await this.navigate(this.oshi,ROOT+'?tab=tasks');
    await this.waitForTasks();
  }
  async navigate(page,url) {
    // Retrying navigation is read-only. No social action is replayed here.
    for(let attempt=0;attempt<2;attempt++) {
      this.check();
      try{return await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});}
      catch(e){if(e.name!=='TimeoutError'||attempt===1)throw e;this.check();this.log('页面加载较慢，正在重新加载一次');}
    }
  }
  async release() {
    // Only our Oshi work tab is closed. Leave X tabs for inspection/recovery.
    // For connectOverCDP, Browser.close disconnects the transport, not Chrome.
    const browser=this.browser,oshi=this.oshi;
    this.browser=null;this.context=null;this.oshi=null;this.x=null;this.port=null;this.account=null;this.expectedAccount=null;
    try { if(oshi&&!oshi.isClosed())await oshi.close(); }
    finally { if(browser?.isConnected())await browser.close(); }
  }
  async guard(page) {
    this.check();
    if (page.isClosed()) throw new Error('任务页面已关闭');
    // The manager may leave the previous tab in the background after opening X.
    // Restore rendering before Playwright waits for stable, visible controls.
    await page.bringToFront();
    const url=new URL(page.url());
    if (!['studio.oshi-labs.com','x.com','www.x.com','twitter.com'].includes(url.hostname)) throw new Error('页面离开预期网站，请手动检查');
    if (/\/i\/(flow\/login|flow\/consent|flow\/challenge)|\/account\/access/.test(url.pathname)) throw new Error('X 需要登录或人工验证，请在浏览器处理后重试');
    if (await page.locator('iframe[src*="captcha"], iframe[src*="arkoselabs"]').count()) throw new Error('检测到验证页面，请手动处理');
    if(page===this.x && this.expectedAccount) {
      const profile=page.getByTestId('AppTabBar_Profile_Link');
      if(await profile.count()) {
        const href=await profile.getAttribute('href');
        if(xUrl(new URL(href,'https://x.com').href).handle!==this.expectedAccount)throw new Error('X 账号在执行中发生变化，已停止');
      }
    }
  }
  async waitForTasks() {
    await this.oshi.locator('#oshi-main').waitFor();
    await this.oshi.locator('#pending-tasks-heading, #completed-tasks-heading').first().waitFor({timeout:20000});
    if (await this.oshi.locator('a[href^="/api/auth/x"],a[href*="studio.oshi-labs.com/api/auth/x"]').count()) throw new Error('请先在此 Chrome 环境中登录 Oshi');
  }
  async scan() {
    await this.guard(this.oshi); await this.waitForTasks();
    const cards=await this.oshi.locator('section[aria-labelledby="pending-tasks-heading"] article.oshi-task').evaluateAll(els=>els.map(el=>({
      title:el.querySelector('h3')?.textContent?.trim()||'任务',
      url:el.querySelector('a[target="_blank"]')?.href||'',
      buttons:[...el.querySelectorAll('button')].map(b=>b.textContent).join(' ')
    })));
    const seen=new Set();
    return cards.filter(t=>t.url).map(t=>{
      const type=taskType(t.title,t.buttons,t.url);
      const url=type==='manual'?t.url:xUrl(t.url).url;
      const result={...t,type,url}; result.key=taskKey(result);
      if(seen.has(result.key)) throw new Error('出现重复任务标识，已停止以避免提交到错误任务');
      seen.add(result.key); return result;
    });
  }
  async oshiAccount() {
    const p=await this.context.newPage();
    try {
      await this.navigate(p,ROOT+'?tab=account');
      await p.locator('#oshi-main').waitFor();
      for(let i=0;i<30;i++) {
        this.check();
        const text=await p.locator('#oshi-main').innerText();
        const m=text.match(/@([a-zA-Z0-9_]{1,15})\b/);
        if(m)return m[1].toLowerCase();
        await sleep(300);
      }
      throw new Error('无法读取 Oshi 登录账号，请先登录');
    } finally { await p.close().catch(()=>{}); }
  }
  async card(task, completed=false) {
    const cards=this.oshi.locator(`section[aria-labelledby="${completed?'completed':'pending'}-tasks-heading"] article.oshi-task`);
    const rows=await cards.evaluateAll(els=>els.map(el=>({href:el.querySelector('a[target="_blank"]')?.getAttribute('href'),title:el.querySelector('h3')?.textContent?.trim(),buttons:[...el.querySelectorAll('button')].map(b=>b.textContent).join(' ')})));
    const matches=[];
    for(const row of rows) {
      const {href,title,buttons}=row;if(!href)continue;
      let url; try{url=xUrl(new URL(href,ROOT).href).url;}catch{continue;}
      const type=taskType(title,buttons,url);
      if(url===task.url && type===task.type) matches.push(row);
    }
    if(matches.length>1) throw new Error('同一链接对应多个相同类型任务，需人工确认');
    if(!matches.length)return null;
    const row=matches[0];
    const byLink=cards.filter({has:this.oshi.locator(`a[href=${JSON.stringify(row.href)}]`)});
    // Browser translation can change "Comment" to "评论" between resolving a
    // locator and clicking. Task URLs stay stable; don't bind to a title snapshot.
    if(await byLink.count()===1)return byLink;
    const names={reply:/comment|评论|留言|コメント|返信/i,follow:/follow|关注|フォロー/i,repost:/retweet|repost|リツイート|里ツイート|转帖|转推|转发/i,like:/like|点赞|いいね/i};
    const specific=byLink.filter({has:this.oshi.getByRole('heading',{name:names[task.type]})});
    if(await specific.count()!==1)throw new Error('任务入口不唯一，请刷新任务列表后重试');
    return specific;
  }
  async closeDialog() {
    const close=this.oshi.locator('[role="dialog"] [data-slot="dialog-close"]');
    if(await close.isVisible().catch(()=>false)) await close.click();
  }
  async replyDialog(task) {
    await this.guard(this.oshi); await this.closeDialog();
    const c=await this.card(task); if(!c) throw new Error('未找到待办任务，请刷新列表');
    await c.locator('button').scrollIntoViewIfNeeded();
    await c.locator('button').click({timeout:20000});
    await this.oshi.locator('#reply-url').waitFor();
    const dialog=this.oshi.locator('[role="dialog"]').filter({has:this.oshi.locator('#reply-url')});
    const author=await dialog.locator('.oshi-task-dialog-label small').innerText();
    const handle=author.replace(/\s|@/g,'').toLowerCase();
    if(!/^[a-z0-9_]{1,15}$/.test(handle)) throw new Error('无法识别 Oshi 绑定的 X 账号');
    return {dialog,handle};
  }
  async openTarget(task) {
    await this.guard(this.oshi); await this.closeDialog();
    const c=await this.card(task); if(!c) throw new Error('任务已经完成或列表已变化，请刷新');
    if(this.endpoint){this.x=await this.context.newPage();await this.navigate(this.x,task.url);}
    else {const popup=this.oshi.waitForEvent('popup',{timeout:12000});await c.locator('a[target="_blank"]').first().click();this.x=await popup;await this.x.waitForLoadState('domcontentloaded');}
    await this.guard(this.x);
    await this.x.getByTestId('AppTabBar_Profile_Link').waitFor({timeout:20000});
    const href=await this.x.getByTestId('AppTabBar_Profile_Link').getAttribute('href');
    this.account=xUrl(new URL(href,'https://x.com').href).handle;
    // Verify destination before performing any social action.
    if(xUrl(this.x.url()).url.toLowerCase()!==task.url.toLowerCase()) throw new Error('打开的 X 页面与任务链接不同');
    return this.account;
  }
  async targetPost(task) {
    const id=xUrl(task.url,true).id;
    // Timestamp link identifies the post, excluding quoted posts and media links.
    const locator=this.x.locator('article[data-testid="tweet"]').filter({has:this.x.locator(`a[href$="/status/${id}"] time`)});
    await locator.first().waitFor({timeout:20000});
    if(await locator.count()!==1) throw new Error('目标推文定位不唯一');
    return locator;
  }
  async postText(task) { return (await (await this.targetPost(task)).getByTestId('tweetText').innerText()).trim(); }
  postControl(post,id) {
    // X Articles embed a second toolbar inside the tweet. Only use the outer
    // tweet's controls; an article/quoted-post toolbar is not the action target.
    return post.locator(`button[data-testid="${id}"]:not([data-testid="twitterArticleReadView"] *):not([data-testid="quoteTweet"] *)`).filter({visible:true});
  }
  async actionControl(post,id,doneId) {
    const action=this.postControl(post,id),done=doneId?this.postControl(post,doneId):null;
    await action.or(done||action).first().waitFor({timeout:20000});
    const ready=await action.count(),finished=done?await done.count():0;
    if(ready+finished!==1)throw new Error('原帖操作按钮不唯一，请检查 X 页面后重试；未点击任何按钮');
    return finished?null:action;
  }
  async like(task) {
    for(let attempt=0;attempt<2;attempt++) {
      await this.guard(this.x); const post=await this.targetPost(task);
      // A timed-out click may have reached X. Re-read the state before retrying;
      // only a unique Like control may be clicked, never an Unlike control.
      const button=await this.actionControl(post,'like','unlike');if(!button)return;
      try {
        await button.click({timeout:30000});
        await this.postControl(post,'unlike').waitFor({timeout:30000});
        this.log('已确认点赞');return;
      } catch(e) {
        if(e.name!=='TimeoutError')throw e;
        await this.guard(this.x);
        if(!await this.actionControl(await this.targetPost(task),'like','unlike')){this.log('已确认点赞');return;}
        if(attempt===1)throw taskIssue('点赞操作等待超时，尚未确认成功；请检查 X 页面，重试前会先读取点赞状态');
        this.log('点赞等待超时，已重新检查状态，正在重试一次');
      }
    }
  }
  async follow(task) {
    await this.guard(this.x);
    const target=xUrl(task.url);
    if(target.id || xUrl(this.x.url()).url.toLowerCase()!==target.url.toLowerCase())throw new Error('关注页面与任务账号不一致，已停止');
    // A profile includes recommendation buttons in primaryColumn too. Match the
    // exact account in the accessible label, independent of translated wording.
    const column=this.x.getByTestId('primaryColumn');
    const controls=column.getByRole('button',{name:new RegExp(`@${target.handle}$`,'i')})
      .and(column.locator('button[data-testid$="-follow"],button[data-testid$="-unfollow"]')).filter({visible:true});
    await controls.first().waitFor({timeout:20000}).catch(()=>{throw new Error(`未能加载 @${target.handle} 的关注状态，请检查 X 页面后重试`);});
    if(await controls.count()!==1)throw new Error(`@${target.handle} 的关注按钮不唯一，已停止以避免误操作`);
    const id=await controls.getAttribute('data-testid');
    if(!/^\d+-(?:un)?follow$/.test(id))throw new Error('无法核对关注按钮的账号标识');
    if(id.endsWith('-unfollow')) {this.log(`@${target.handle} 已关注，继续提交任务`);return;}
    await this.guard(this.x);await controls.click();
    // Only the same account's changed state confirms success; never click it again.
    await column.getByTestId(id.replace(/-follow$/,'-unfollow')).waitFor({timeout:20000})
      .catch(()=>{throw new Error(`尚未确认 @${target.handle} 关注成功，请检查 X 提示后重试`);});
    this.log(`已确认关注 @${target.handle}`);
  }
  async repost(task) {
    await this.guard(this.x); const post=await this.targetPost(task);
    const button=await this.actionControl(post,'retweet','unretweet');if(!button)return;
    await button.click();
    await this.x.getByTestId('retweetConfirm').click();
    await this.postControl(post,'unretweet').waitFor(); this.log('已确认转帖');
  }
  async publish(task,text,onBeforeSend) {
    await this.guard(this.x);
    // Use the target post's reply button so parentage is explicit.
    await (await this.actionControl(await this.targetPost(task),'reply')).click({timeout:30000});
    // X renders nested dialogs; select the innermost composer, not both ancestors.
    const dialog=this.x.getByRole('dialog').filter({has:this.x.getByTestId('tweetTextarea_0')}).last();
    await dialog.waitFor({timeout:30000}).catch(e=>{if(e.name!=='TimeoutError')throw e;throw taskIssue('回复框在 30 秒内未打开，尚未发送回复；请检查 X 页面后重试');});
    await dialog.getByTestId('tweetTextarea_0').fill(text);
    const existing=new Set(await this.x.locator('a[href*="/status/"]').evaluateAll(els=>els.map(a=>a.href.split('?')[0])));
    await this.guard(this.x); await onBeforeSend();
    await dialog.getByTestId('tweetButton').click();
    // Never infer a reply URL from a tweet ID or use the original post URL.
    let url=null;
    for(let i=0;i<40;i++) {
      await this.guard(this.x);
      const candidates=await this.x.locator('[data-testid="toast"] a[href*="/status/"]').evaluateAll(els=>els.map(a=>a.href));
      for(const candidate of candidates.filter(c=>!existing.has(c.split('?')[0]))) {
        try{url=validateReplyUrl(candidate,this.account,task.url);break;}catch{}
      }
      if(!url) {
        const visible=await this.x.locator('article[data-testid="tweet"]').evaluateAll(els=>els.map(el=>({text:el.querySelector('[data-testid="tweetText"]')?.innerText,href:el.querySelector('a:has(time)')?.href})));
        const matches=visible.filter(v=>v.text?.trim()===text).map(v=>v.href).filter(v=>v&&!existing.has(v.split('?')[0]));
        for(const candidate of matches) {try{url=validateReplyUrl(candidate,this.account,task.url);break;}catch{}}
      }
      if(url) break; await sleep(500);
    }
    if(!url) throw new Error('发送结果不确定：请在 X 检查该回复，并在工具中补填真实回复链接；不会自动再次发帖');
    return url;
  }
  async verifyReply(task,url,account,text) {
    url=validateReplyUrl(url,account,task.url);
    const page=await this.context.newPage();
    try {
      await this.navigate(page,url); await this.guard(page);
      const id=xUrl(url,true).id, parent=xUrl(task.url,true).id;
      const reply=page.locator('article[data-testid="tweet"]').filter({has:page.locator(`a[href$="/status/${id}"] time`)});
      await reply.waitFor({timeout:20000});
      const body=await reply.getByTestId('tweetText').innerText();
      if(text && body.trim()!==text.trim()) throw new Error('回复内容与记录不一致，请人工检查');
      // X's reply permalink displays the direct parent above the reply.
      await this.waitForReplyParent(page,id,parent);
      return url;
    } finally { await page.close().catch(()=>{}); }
  }
  async waitForReplyParent(page,id,parent,{timeout=20000,interval=500}={}) {
    const deadline=Date.now()+timeout;
    do {
      this.check();
      // Newly published replies can render before their conversation ancestors.
      // Read only; do not publish again or accept an unrelated/quoted timestamp.
      const posts=await page.locator('article[data-testid="tweet"]').evaluateAll(els=>els.map(el=>{
        const links=[...el.querySelectorAll('a:has(time)')].filter(e=>e.closest('article[data-testid="tweet"]')===el&&!e.closest('[data-testid="quoteTweet"], [data-testid="twitterArticleReadView"]'));
        return {href:links.length===1?links[0].getAttribute('href')?.split('?')[0]:null,unavailable:!links.length&&/这个帖子不可用|此帖子不可用|this post is unavailable|this tweet is unavailable|このポストは表示できません|このポストは利用できません/i.test(el.textContent||'')};
      }));
      const ri=posts.findIndex(p=>p.href?.endsWith(`/status/${id}`));
      if(ri>0&&posts[ri-1].href?.endsWith(`/status/${parent}`))return;
      if(ri>0&&posts[ri-1].unavailable)throw taskIssue('回复上方的原帖在 X 显示不可用，无法确认对话关系；回复链接已保留，原帖恢复可见后可只续交链接');
      if(Date.now()>=deadline)break;
      await sleep(Math.min(interval,Math.max(0,deadline-Date.now())));
    } while(Date.now()<=deadline);
    throw taskIssue('等待对话加载后仍无法确认回复属于目标原帖；链接已保留，请检查对话关系后只续交链接');
  }
  async completed(task) { await this.closeDialog(); return Boolean(await this.card(task,true)); }
  async submitReply(task,url,account) {
    const {dialog,handle}=await this.replyDialog(task);
    if(handle!==account) throw new Error('Oshi 与 X 登录账号不一致，已停止');
    await dialog.locator('#reply-url').fill(validateReplyUrl(url,account,task.url));
    await this.guard(this.oshi); await dialog.locator('button[type="submit"]').click();
    // A click or dialog close is not success. Require the task in the completed section.
    for(let i=0;i<30;i++) {
      this.check();
      if(await this.card(task,true)) {await this.closeDialog();return;}
      const error=await dialog.locator('[role="alert"]').innerText().catch(()=>null);
      if(error) throw new Error('Oshi 未接受链接：'+error);
      await sleep(500);
    }
    throw new Error('未确认 Oshi 提交成功。链接已保存，重试不会重复回复');
  }
  async submitSimple(task) {
    if(this.expectedAccount && await this.oshiAccount()!==this.expectedAccount)throw new Error('Oshi 账号在执行中发生变化，已停止');
    await this.guard(this.oshi); const c=await this.card(task);
    if(!c) { if(await this.card(task,true)) return; throw new Error('任务卡片丢失'); }
    const button=c.locator('button');
    if(await button.count()!==1) throw new Error('任务完成按钮不唯一，请检查页面');
    if(!await button.isEnabled() && this.endpoint) {
      // Extension work tabs open X directly, so Oshi has not received its link
      // click. Use the real task entry to satisfy the site's prerequisite; do
      // not force-enable the report button or assume that a click means success.
      const entry=c.locator('a[target="_blank"]');
      if(await entry.count()!==1) throw new Error('任务入口不唯一，请检查页面');
      const href=await entry.getAttribute('href');
      if(xUrl(new URL(href,ROOT).href).url.toLowerCase()!==task.url.toLowerCase())throw new Error('任务入口与目标账号不一致');
      this.log('正在打开官网任务入口，等待完成按钮可用');
      await entry.click();
      await this.guard(this.oshi);
      await c.locator('button:not([disabled])').waitFor({state:'visible',timeout:10000}).catch(()=>{throw new Error('已打开官网任务入口，但完成按钮仍不可用，请检查官网提示');});
    }
    if(!await button.isEnabled()) throw new Error('任务完成按钮尚不可用，请检查页面');
    await button.click();
    for(let i=0;i<30;i++) {this.check();if(await this.card(task,true))return;await sleep(500);}
    throw new Error('操作已完成，但尚未确认 Oshi 记分，请刷新检查');
  }
  async cleanupTarget() { if(this.x && !this.x.isClosed()) await this.x.close().catch(()=>{}); this.x=null; }
}
