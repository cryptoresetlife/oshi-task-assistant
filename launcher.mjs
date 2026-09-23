import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
const version=JSON.parse(fs.readFileSync(new URL('./package.json',import.meta.url),'utf8')).version;
const port=Number(process.env.OSHI_PORT||18745);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('助手端口无效');
const address=`http://127.0.0.1:${port}`;
async function health(){
  try{const r=await fetch(address+'/api/health',{signal:AbortSignal.timeout(2000)});if(!r.ok)return {unknown:true};const data=await r.json();return data.app==='oshi-task-assistant'?data:{unknown:true};}
  catch(e){if(e.cause?.code==='ECONNREFUSED')return null;return {unknown:true};}
}
function open(){const child=spawn('cmd.exe',['/c','start','',address],{windowsHide:true,stdio:'ignore'});child.on('error',()=>console.log('请在浏览器打开：'+address));}
const existing=await health();
if(existing){
  if(existing.unknown)console.log(`端口 ${port} 已被旧版助手或其他程序占用。请关闭旧助手服务后再启动；不会另开端口或结束其他程序。`);
  else{console.log(existing.version===version&&!existing.updateAvailable?'助手已经运行，正在打开原有界面。':`当前后台为 v${existing.version}，本目录为 v${version}。请等待队列结束，在页面点击“关闭助手服务”，然后重新启动。`);open();}
}else{
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,stdio:'inherit',windowsHide:true});let exited=false;
  child.on('exit',code=>{exited=true;process.exitCode=code||0;});
  child.on('error',e=>{exited=true;console.error(e.message);process.exitCode=1;});
  for(let i=0;i<40&&!exited;i++){
    const ready=await health();if(ready&&!ready.unknown&&ready.version===version){open();break;}
    await new Promise(r=>setTimeout(r,250));
  }
}
