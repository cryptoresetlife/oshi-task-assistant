import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the shipped script with an empty panel; selection logic needs no browser.
function panel() {
  const elements=new Map();
  const node=()=>({setAttribute(){},before(){},replaceChildren(){},querySelectorAll(){return [];}});
  const context=vm.createContext({
    node,$:id=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);},
    state:{busy:false},requestBusy:false,availableProfiles:[],action:fn=>fn()
  });
  return vm.runInContext(fs.readFileSync(new URL('../public/batch.js',import.meta.url),'utf8')+
    '\n({syncBatchSelection,batchAction,batchError})',context);
}
const tasks=n=>Array.from({length:n},(_,i)=>({key:`task-${i}`}));
const card=()=>({selected:new Set(),seen:new Set()});

test('65 tasks default to 60 selections and retain the remaining tasks',()=>{
  const ui=panel(),c=card(),all=tasks(65);ui.syncBatchSelection(c,all);
  assert.equal(c.selected.size,60);assert.equal(c.seen.size,65);assert.equal(all.length,65);
  assert.ok(c.selected.has('task-59'));assert.ok(!c.selected.has('task-60'));
  ui.syncBatchSelection(c,all);assert.equal(c.selected.size,60);
});
test('polling preserves a manual deselection without silently filling its slot',()=>{
  const ui=panel(),c=card(),all=tasks(65);ui.syncBatchSelection(c,all);
  c.selected.delete('task-3');ui.syncBatchSelection(c,all);
  assert.equal(c.selected.size,59);assert.ok(!c.selected.has('task-3'));
  assert.ok(!c.selected.has('task-60'));
});
test('a fresh scan can select previously deferred tasks and removes stale selections',()=>{
  const ui=panel(),c=card();ui.syncBatchSelection(c,tasks(65));
  const remaining=tasks(65).slice(60);ui.syncBatchSelection(c,remaining);
  assert.equal(c.selected.size,0);
  const refreshed=card();ui.syncBatchSelection(refreshed,remaining);assert.equal(refreshed.selected.size,5);
});
test('a rejected batch start is visible in the parallel panel and clears on next action',async()=>{
  const ui=panel();await assert.rejects(ui.batchAction(async()=>{throw Error('start failed');}),/start failed/);
  assert.equal(ui.batchError.hidden,false);assert.equal(ui.batchError.textContent,'start failed');
  await ui.batchAction(async()=>{});assert.equal(ui.batchError.hidden,true);
});
