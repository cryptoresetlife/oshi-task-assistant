const $=id=>document.getElementById(id);
async function request(msg){const r=await chrome.runtime.sendMessage(msg);$('status').textContent=r.error||r.status;return r;}
chrome.storage.local.get(['address','name']).then(v=>{if(v.address)$('address').value=v.address;if(v.name)$('name').value=v.name;});
request({type:'status'});
$('connect').onclick=async()=>{try{$('connect').disabled=true;const r=await request({type:'connect',address:$('address').value.trim(),token:$('token').value.trim(),name:$('name').value.trim()});if(!r.error)$('token').value='';}catch(e){$('status').textContent=e.message;}finally{$('connect').disabled=false;}};
$('disconnect').onclick=()=>request({type:'disconnect'});
