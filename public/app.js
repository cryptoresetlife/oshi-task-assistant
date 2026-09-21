const $=id=>document.getElementById(id), token=document.querySelector('meta[name="oshi-token"]').content;
let state={tasks:[],events:[],records:[]},selected=new Set(),drafts={},taskSignature='',recordSignature='',pendingKey='',requestBusy=false,lastErrorSignature='';
const draftsByAccount=new Map();
const profileScope=p=>p?`${p.id}:${p.account}`:'';
const labels={reply:'评论',follow:'关注',like:'点赞',repost:'转帖',manual:'手动任务'};
const stages={prepared:'回复已准备',posting:'需核对发布结果',uncertain:'需核对发布结果',posted:'已有回复链接',acted:'操作已完成',done:'已提交完成'};
function node(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function showError(error){$('error').textContent=error?.message||String(error);$('error').hidden=false;}
async function api(route,body){const response=await fetch('/api/'+route,{method:body===undefined?'GET':'POST',headers:{'X-Oshi-Token':token,...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw new Error(data.error||'请求失败');return data;}
async function action(fn){if(requestBusy)return;requestBusy=true;connectionControls();$('error').hidden=true;try{await fn();}catch(e){showError(e);}finally{requestBusy=false;connectionControls();}}
function mode(){return document.querySelector('input[name=mode]:checked').value;}
function settings(){return {mode:mode(),text:$('template').value,endpoint:$('endpoint').value,model:$('model').value,apiKey:$('api-key').value,instructions:$('instructions').value,like:$('like').checked,autoPublish:$('auto-publish').checked,interval:Number($('interval').value)};}
function savePrefs(){const s=settings();delete s.apiKey;localStorage.setItem('oshi-prefs-v1',JSON.stringify(s));}
try{const p=JSON.parse(localStorage.getItem('oshi-prefs-v1')||'{}');for(const [field,key]of [['template','text'],['endpoint','endpoint'],['model','model'],['instructions','instructions'],['interval','interval']])if(p[key]!==undefined)$(field).value=p[key];if(p.like!==undefined)$('like').checked=p.like;
if(p.mode==='auto')document.querySelector('input[name=mode][value=auto]').checked=true;
// Direct publishing deliberately starts unchecked after a page reload.
}catch{}
function renderMode(){$('auto-fields').hidden=mode()!=='auto';$('manual-fields').hidden=mode()!=='manual';taskSignature='';renderTasks();}
document.querySelectorAll('input[name=mode]').forEach(e=>e.addEventListener('change',()=>{renderMode();savePrefs();}));
for(const id of ['template','endpoint','model','instructions','interval','like'])$(id).addEventListener('change',savePrefs);
function renderTasks(){
  const sig=JSON.stringify(state.tasks)+mode();if(sig===taskSignature)return;taskSignature=sig;
  const list=$('task-list');list.replaceChildren();$('count').textContent=state.tasks.length;
  if(!state.tasks.length){const e=node('div',undefined,'empty');e.append(node('span',state.profile?'✓':'↗'),node('h3',state.profile?'当前没有待办任务':'从连接环境开始'),node('p',state.profile?'新任务出现后可点击刷新任务。':'连接后，这里会列出当前账号的待办任务。'));list.append(e);}
  for(const task of state.tasks){const item=node('div',undefined,'task-item');item.dataset.key=task.key;const head=node('div',undefined,'task-item-head');const check=node('input');check.type='checkbox';check.checked=selected.has(task.key);check.disabled=task.type==='manual'||state.busy;check.setAttribute('aria-label','选择 '+task.title+' '+task.url);check.addEventListener('change',()=>{check.checked?selected.add(task.key):selected.delete(task.key);updateSelection();});const body=node('div',undefined,'task-body'),title=node('div',undefined,'task-title');title.append(node('span',task.title),node('span',labels[task.type],'tag'));const a=node('a',task.url,'task-link');a.href=task.url;a.target='_blank';a.rel='noreferrer';body.append(title,a);
    if(task.type==='reply'&&mode()==='manual'){const input=node('textarea');input.rows=2;input.placeholder='本条回复（留空使用左侧默认内容）';input.value=drafts[task.key]||'';input.disabled=state.busy;input.setAttribute('aria-label','回复 '+task.url);input.addEventListener('input',()=>drafts[task.key]=input.value);body.append(input);}
    head.append(check,body);item.append(head);list.append(item);
  }updateSelection();
}
function connectionControls(){for(const id of ['launch-chrome','add-chrome','chrome-port'])$(id).disabled=state.busy||requestBusy;const differs=state.profile&&$('profile').value!==state.profile.id;$('profile').disabled=state.busy;$('profiles').disabled=state.busy;$('connect').textContent=state.profile?'切换环境':'连接环境';$('connect').disabled=state.busy||!$('profile').value||Boolean(state.profile&&!differs);$('scan').disabled=!state.profile||state.busy||Boolean(differs);}
function updateSelection(){for(const k of selected)if(!state.tasks.some(t=>t.key===k))selected.delete(k);$('selected-count').textContent=`已选 ${selected.size} 项`;$('start').disabled=!state.profile||state.busy||!selected.size||$('profile').value!==state.profile.id;const eligible=state.tasks.filter(t=>t.type!=='manual');$('select-all').checked=eligible.length>0&&eligible.every(t=>selected.has(t.key));}
$('profile').addEventListener('change',()=>{connectionControls();updateSelection();});
$('select-all').addEventListener('change',()=>{selected=$('select-all').checked?new Set(state.tasks.filter(t=>t.type!=='manual').map(t=>t.key)):new Set();taskSignature='';renderTasks();});
function renderRecords(){const sig=JSON.stringify(state.records);if(sig===recordSignature)return;recordSignature=sig;const records=$('records');records.replaceChildren();if(!state.records.length)records.append(node('p','暂无执行记录。','muted'));
  for(const r of [...state.records].reverse()){const row=node('div',undefined,'record');const status=node('div',stages[r.stage]||r.stage||(r.error?'需处理':'待确认'));status.append(node('small',r.updatedAt?new Date(r.updatedAt).toLocaleString():''));const detail=node('div',r.title);detail.append(node('small',r.text||''));const target=node('a','查看原帖');target.href=r.target;target.target='_blank';target.rel='noreferrer';detail.append(target);const result=node('div');if(r.replyUrl){const a=node('a',r.replyUrl);a.href=r.replyUrl;a.target='_blank';a.rel='noreferrer';result.append(a);}else {const type=r.type||state.tasks.find(t=>t.key===r.task)?.type;result.append(node('span',type&&type!=='reply'?'此任务无需回复链接':'尚无回复链接','muted'));}
  if(r.replyUrl&&r.stage!=='done'){const resume=node('button','只续交此链接');resume.disabled=state.busy;resume.onclick=()=>action(async()=>apply(await api('resume',{key:r.task})));result.append(node('br'),resume);}
  if(r.error){const warning=node('small',r.error.split('\n')[0]);warning.className='record-error';result.append(warning);}
  if(['posting','uncertain','posted','prepared'].includes(r.stage)){const recovery=node('div',undefined,'recovery'),input=node('input'),btn=node('button','补填链接');input.placeholder='粘贴自己的真实回复链接';input.setAttribute('aria-label','补填 '+r.title+' 回复链接');btn.disabled=state.busy;btn.onclick=()=>action(async()=>apply(await api('recover',{key:r.task,url:input.value})));recovery.append(input,btn);result.append(recovery);}row.append(status,detail,result);records.append(row);}
}
function apply(s){const changedBusy=state.busy!==s.busy;
  const before=profileScope(state.profile),after=profileScope(s.profile);
  if(before!==after){if(before)draftsByAccount.set(before,{...drafts});drafts={...(draftsByAccount.get(after)||{})};selected.clear();taskSignature='';recordSignature='';pendingKey='';if(s.profile)$('profile').value=s.profile.id;}
  state=s;$('status').textContent=s.status;$('account').textContent=s.profile?`当前连接：${s.profile.name} · @${s.profile.account}`:'尚未连接';connectionControls();$('stop').disabled=!s.busy;$('select-all').disabled=s.busy;document.querySelectorAll('.settings input,.settings textarea').forEach(e=>e.disabled=s.busy);if(changedBusy){taskSignature='';recordSignature='';}renderTasks();renderRecords();updateSelection();document.querySelectorAll('.task-item').forEach(e=>e.classList.toggle('current',e.dataset.key===s.current));
  const errorSig=JSON.stringify(s.lastError||null);if(errorSig!==lastErrorSignature){lastErrorSignature=errorSig;if(s.lastError){showError(s.lastError.message);document.querySelector('details.logs').open=true;}}
  $('review').hidden=!s.pending;if(s.pending&&s.pending.key!==pendingKey){pendingKey=s.pending.key;$('review-text').value=s.pending.text;$('review-target').textContent=s.pending.url;$('review-target').href=s.pending.url;$('review').scrollIntoView({behavior:'smooth',block:'center'});}if(!s.pending)pendingKey='';
  const logs=$('logs');logs.replaceChildren();for(const event of s.events){const line=node('div',undefined,'log-line');line.append(node('time',event.time),node('span',event.message));logs.append(line);}logs.scrollTop=logs.scrollHeight;
}
async function loadProfiles(wanted=$('profile').value||state.profile?.id){const ps=await api('profiles');$('profile').replaceChildren();const placeholder=node('option','请选择已启动的环境');placeholder.value='';$('profile').append(placeholder);for(const p of ps){const o=node('option',`${p.name} · ${p.running?'已启动':'未启动'}${p.debugPort?' · '+p.debugPort:''}`);o.value=p.id;o.disabled=!p.running;$('profile').append(o);}const chosen=ps.find(p=>p.id===wanted&&p.running)||ps.find(p=>p.running);$('profile').value=chosen?chosen.id:'';if(!ps.length)placeholder.textContent='请先启动普通 Chrome 或多开环境';connectionControls();updateSelection();}
$('profiles').onclick=()=>action(loadProfiles);
$('launch-chrome').onclick=()=>action(async()=>{const result=await api('chrome/launch',{});await loadProfiles(result.id);$('chrome-note').textContent='普通 Chrome 已启动。请在新窗口登录 Oshi 和 X，再点击“连接环境 / 切换环境”。下次启动会保留此环境的登录状态。';});
$('add-chrome').onclick=()=>action(async()=>{const result=await api('chrome/add',{port:$('chrome-port').value});await loadProfiles(result.id);$('chrome-note').textContent='已找到本机 Chrome。请确认其中已登录 Oshi 和 X，再点击连接。';});
$('connect').onclick=()=>action(async()=>{if(!$('profile').value)throw new Error('先在多开管理器中启动一个环境，再刷新环境');$('status').textContent='连接中…';apply(await api('connect',{id:$('profile').value}));});
$('scan').onclick=()=>action(async()=>{apply(await api('scan',{}));});
$('start').onclick=()=>action(async()=>{savePrefs();apply(await api('start',{keys:[...selected],settings:settings(),drafts}));});
$('stop').onclick=()=>action(async()=>{apply(await api('stop',{}));});
$('approve').onclick=()=>action(async()=>{apply(await api('approve',{key:pendingKey,text:$('review-text').value}));});
$('export').onclick=()=>{const blob=new Blob([JSON.stringify(state.records,null,2)],{type:'application/json'}),a=node('a');a.href=URL.createObjectURL(blob);a.download='oshi-records-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
renderMode();action(async()=>{await loadProfiles();apply(await api('state'));});
let polling=false;setInterval(async()=>{if(polling)return;polling=true;try{apply(await api('state'));}catch(e){$('status').textContent='服务未连接';}finally{polling=false;}},1500);
