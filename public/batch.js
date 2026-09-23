let batchSources=[],batchChosen=new Set(),batchCards=new Map(),batchSourceSignature='';
const batchTaskLimit=60;
const batchError=node('p',undefined,'record-error');batchError.hidden=true;batchError.setAttribute('role','alert');$('batch-workers').before(batchError);
function batchAction(fn){return action(async()=>{batchError.hidden=true;try{await fn();}catch(e){batchError.textContent=e.message||String(e);batchError.hidden=false;throw e;}});}
function syncBatchSelection(card,eligible){
  const keys=new Set(eligible.map(t=>t.key));
  for(const key of card.selected)if(!keys.has(key))card.selected.delete(key);
  for(const task of eligible)if(!card.seen.has(task.key)){card.seen.add(task.key);if(card.selected.size<batchTaskLimit)card.selected.add(task.key);}
}
function batchApplySnapshot(s){apply(s);}
function renderBatchSources(profiles){
  batchSources=profiles;
  const signature=JSON.stringify(profiles);if(signature===batchSourceSignature)return;batchSourceSignature=signature;
  const host=$('batch-environments');host.replaceChildren();
  for(const p of profiles){const label=node('label',undefined,'check'),check=node('input');check.type='checkbox';check.dataset.profile=p.id;check.checked=batchChosen.has(p.id)&&p.running;check.disabled=!p.running||state.busy||state.batch?.busy;check.setAttribute('aria-label','并行环境 '+p.name);check.onchange=()=>{check.checked?batchChosen.add(p.id):batchChosen.delete(p.id);};label.append(check,node('span',p.name+(p.running?'':'（未启动）')));host.append(label);}
}
function renderBatch(){
  const b=state.batch||{busy:false,phase:'未扫描',workers:[]};const locked=state.busy||b.busy;
  $('batch-status').textContent=b.phase;
  $('batch-limit').disabled=locked;$('batch-prepare').disabled=locked||requestBusy;$('batch-run').disabled=locked||requestBusy||!b.workers.some(w=>w.profile&&!w.disabled);$('batch-stop').disabled=!b.busy;
  $('batch-all').disabled=locked;for(const input of $('batch-environments').querySelectorAll('input'))input.disabled=locked||!batchSources.find(p=>p.id===input.dataset.profile)?.running;
  for(const [id,card]of batchCards)if(!b.workers.some(w=>w.id===id)){card.root.remove();batchCards.delete(id);}
  for(const w of b.workers){
    let card=batchCards.get(w.id);
    if(!card){
      const root=node('article',undefined,'batch-card'),title=node('h3'),status=node('p',undefined,'muted'),error=node('p',undefined,'record-error');
      const tasks=node('details'),summary=node('summary'),list=node('div',undefined,'batch-task-list');
      const selectRound=node('button','选择本轮任务'),selectNone=node('button','全不选'),selectionTools=node('div',undefined,'row');selectionTools.append(selectRound,selectNone);tasks.append(summary,selectionTools,list);
      const review=node('div',undefined,'batch-review'),target=node('a','查看原帖'),input=node('textarea'),approve=node('button','发布这条回复并提交');input.rows=3;input.setAttribute('aria-label','并行回复 '+w.name);target.target='_blank';target.rel='noreferrer';review.append(target,input,approve);
      const stop=node('button','停止此环境');stop.onclick=()=>action(async()=>batchApplySnapshot(await api('batch/stop',{id:w.id})));
      const logs=node('details'),logsTitle=node('summary','运行日志'),logText=node('pre');logs.append(logsTitle,logText);
      const records=node('details'),recordList=node('div');records.append(node('summary','执行记录与回复链接'),recordList);
      const selectionNote=node('p',undefined,'hint');root.append(title,status,error,tasks,selectionNote,review,stop,records,logs);$('batch-workers').append(root);
      card={root,title,status,error,tasks,summary,list,selectionNote,selectRound,selectNone,review,target,input,approve,stop,logText,recordList,recordSig:'',selected:new Set(),seen:new Set(),taskSig:'',pendingKey:''};batchCards.set(w.id,card);
    }
    card.title.textContent=w.name+(w.profile?' · @'+w.profile.account:'');card.status.textContent=w.pending?'等待回复确认':w.stage;card.error.textContent=w.error||w.lastError?.message||'';card.error.hidden=!card.error.textContent;
    card.stop.disabled=!b.busy||w.disabled||!['正在连接','正在运行','等待运行','等待扫描'].includes(w.stage);
    const eligible=w.tasks.filter(t=>t.type!=='manual');syncBatchSelection(card,eligible);
    card.selectRound.disabled=card.selectNone.disabled=locked||w.disabled;
    card.selectNone.onclick=()=>{card.selected.clear();card.taskSig='';renderBatch();};
    card.selectRound.onclick=()=>{card.selected=new Set(eligible.slice(0,batchTaskLimit).map(t=>t.key));card.taskSig='';renderBatch();};
    card.selectionNote.hidden=eligible.length<=batchTaskLimit;
    card.selectionNote.textContent=`每个环境本轮最多 ${batchTaskLimit} 项，默认勾选前 ${batchTaskLimit} 项。其余任务保留，完成后重新扫描可继续选择。`;
    const sig=JSON.stringify(w.tasks)+locked+w.disabled;if(sig!==card.taskSig){card.taskSig=sig;card.list.replaceChildren();
      for(const t of w.tasks){const label=node('label',undefined,'check'),check=node('input');check.type='checkbox';check.checked=card.selected.has(t.key);check.disabled=locked||w.disabled||t.type==='manual';check.setAttribute('aria-label',w.name+' '+t.title+' '+t.url);check.onchange=()=>{if(check.checked&&card.selected.size>=batchTaskLimit){check.checked=false;batchError.textContent=`${w.name} 本轮已选 ${batchTaskLimit} 项，请先取消一项再选择其他任务；未选任务会保留。`;batchError.hidden=false;return;}check.checked?card.selected.add(t.key):card.selected.delete(t.key);card.summary.textContent=`已选 ${card.selected.size} / ${eligible.length} 项可运行任务`;};const link=node('a',t.title+' · '+t.url);link.href=t.url;link.target='_blank';link.rel='noreferrer';label.append(check,link);card.list.append(label);}
    }
    card.summary.textContent=`已选 ${card.selected.size} / ${eligible.length} 项可运行任务`;
    card.review.hidden=!w.pending;
    if(w.pending){if(card.pendingKey!==w.pending.key){card.pendingKey=w.pending.key;card.input.value=w.pending.text;card.target.href=w.pending.url;}
      card.approve.disabled=requestBusy;card.approve.onclick=()=>action(async()=>batchApplySnapshot(await api('batch/approve',{id:w.id,key:card.pendingKey,text:card.input.value})));
    }else card.pendingKey='';
    card.logText.textContent=w.events.map(e=>e.time+' '+e.message).join('\n');
    const recordSig=JSON.stringify(w.records);if(recordSig!==card.recordSig){card.recordSig=recordSig;card.recordList.replaceChildren();for(const r of [...w.records].reverse()){const row=node('p',(stages[r.stage]||'需处理')+' · '+r.title);if(r.replyUrl){const a=node('a',r.replyUrl);a.href=r.replyUrl;a.target='_blank';a.rel='noreferrer';row.append(node('br'),a);}if(r.error)row.append(node('br'),node('small',r.error.split('\n')[0]));card.recordList.append(row);}if(w.records.some(r=>r.stage!=='done'))card.recordList.append(node('p','需补填链接时，先结束并行队列，再在上方连接这个环境，使用执行记录恢复。','hint'));}
  }
}
$('batch-all').onclick=()=>{for(const p of batchSources)if(p.running)batchChosen.add(p.id);batchSourceSignature='';renderBatchSources(batchSources);};
$('batch-prepare').onclick=()=>batchAction(async()=>{const ids=batchSources.filter(p=>p.running&&batchChosen.has(p.id)).map(p=>p.id);if(!ids.length)throw new Error('请先勾选要并行运行的环境');const next=await api('batch/prepare',{ids,limit:Number($('batch-limit').value)});batchCards.clear();$('batch-workers').replaceChildren();batchApplySnapshot(next);});
$('batch-run').onclick=()=>batchAction(async()=>{const plans=state.batch.workers.filter(w=>!w.disabled&&w.profile).map(w=>({id:w.id,keys:[...(batchCards.get(w.id)?.selected||[])]})).filter(p=>p.keys.length);if(!plans.length)throw new Error('请先扫描环境并勾选任务');savePrefs();batchApplySnapshot(await api('batch/start',{plans,settings:settings(),limit:Number($('batch-limit').value)}));});
$('batch-stop').onclick=()=>action(async()=>batchApplySnapshot(await api('batch/stop',{})));
renderBatchSources(availableProfiles);renderBatch();
