import crypto from 'node:crypto';
import {WebSocketServer} from 'ws';

// Each extension connection represents one Chrome profile. CDP clients only
// see the work tabs they create through that connection, never existing tabs.
export class ExtensionBridge {
  constructor(server,host){
    this.host=host;this.pairToken=crypto.randomBytes(24).toString('hex');this.secret=crypto.randomBytes(24).toString('hex');this.peers=new Map();
    this.wss=new WebSocketServer({noServer:true,maxPayload:16*1024*1024});
    server.on('upgrade',(req,socket,head)=>{
      let url;try{url=new URL(req.url,`http://${host}`);}catch{return socket.destroy();}
      if(req.headers.host!==this.host)return socket.destroy();
      const isExtension=url.pathname==='/extension/socket';
      if(isExtension){
        if(url.searchParams.get('token')!==this.pairToken||!/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin||''))return socket.destroy();
        const id=url.searchParams.get('id');if(!/^[a-zA-Z0-9-]{16,80}$/.test(id||''))return socket.destroy();
        if(this.peers.has(id))return socket.destroy();
        return this.wss.handleUpgrade(req,socket,head,ws=>this.attach(id,ws));
      }
      const id=url.pathname.match(/^\/extension\/cdp\/([a-zA-Z0-9-]+)$/)?.[1],peer=this.peers.get(id);
      if(!peer||url.searchParams.get('token')!==this.secret||req.headers.origin)return socket.destroy();
      this.wss.handleUpgrade(req,socket,head,ws=>this.attachClient(peer,ws));
    });
  }
  attach(id,ws){
    const peer={id,ws,clients:new Map(),name:'已登录 Chrome（扩展）'};this.peers.set(id,peer);
    ws.on('error',()=>{});
    ws.on('message',raw=>{try{const msg=JSON.parse(raw);if(msg.type==='hello'){peer.name=String(msg.name||peer.name).slice(0,60);return;}if(msg.type==='ping'){ws.send('{"type":"pong"}');return;}const client=peer.clients.get(msg.client);if(client?.readyState===1&&msg.message)client.send(JSON.stringify(msg.message));}catch{ws.close(1008,'Invalid message');}});
    ws.on('close',()=>{if(this.peers.get(id)===peer)this.peers.delete(id);for(const c of peer.clients.values())c.close(1001,'Chrome extension disconnected');});
  }
  attachClient(peer,ws){
    const id=crypto.randomUUID();peer.clients.set(id,ws);ws.on('error',()=>{});
    ws.on('message',raw=>{try{const message=JSON.parse(raw);if(!Number.isInteger(message.id)||typeof message.method!=='string')throw new Error();if(peer.ws.readyState!==1)return ws.close();peer.ws.send(JSON.stringify({type:'command',client:id,message}));}catch{ws.close(1008,'Invalid CDP command');}});
    ws.on('close',()=>{peer.clients.delete(id);if(peer.ws.readyState===1)peer.ws.send(JSON.stringify({type:'release',client:id}));});
  }
  profiles(){return [...this.peers.values()].map(p=>({id:'extension:'+p.id,name:p.name,source:'extension',running:true}));}
  endpoint(id){const key=id.replace(/^extension:/,'');if(!this.peers.has(key))throw new Error('Chrome 扩展已断开，请在扩展中重新连接');return `ws://${this.host}/extension/cdp/${key}?token=${this.secret}`;}
  pairing(){return {address:`http://${this.host}`,token:this.pairToken};}
  close(){for(const p of this.peers.values())p.ws.close();this.wss.close();}
}
