const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WebSocketServer } = require('ws');
const { createRoomStore } = require('./room-store');
const { createGameHub } = require('./game-hub');

function createGameServer(options = {}) {
  const store = options.store || createRoomStore();
  const hub = createGameHub(store);
  const files = {'/':'index.html','/index.html':'index.html','/style.css':'style.css','/game.js':'game.js',
    '/manifest.webmanifest':'manifest.webmanifest','/icon.svg':'icon.svg','/icon-192.png':'icon-192.png','/icon-512.png':'icon-512.png'};
  const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8',
    '.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png'};
  const server = http.createServer((req, res) => {
    let url;
    try {url = new URL(req.url, 'http://localhost');} catch {res.writeHead(400);res.end();return;}
    if (url.pathname === '/health' || url.pathname === '/api/play') {
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({ok:true,storage:store.rooms?'memory':'turso',version:'3.0.0'}));return;
    }
    if (url.pathname === '/connection') {
      const lanHosts = process.env.VERCEL ? [] : Object.values(os.networkInterfaces()).flat()
        .filter(ip=>ip&&ip.family==='IPv4'&&!ip.internal&&!ip.address.startsWith('169.254.')).map(ip=>ip.address);
      lanHosts.sort((a,b)=>Number(b.startsWith('192.168.'))-Number(a.startsWith('192.168.')));
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({lanHosts}));return;
    }
    const file = Object.hasOwn(files,url.pathname) ? files[url.pathname] : null;
    if (!file || !['GET','HEAD'].includes(req.method)) {res.writeHead(404);res.end('Not found');return;}
    fs.readFile(path.join(__dirname,file),(error,data)=>{
      if(error){res.writeHead(500);res.end('Could not read file');return;}
      res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
      res.end(req.method==='HEAD'?undefined:data);
    });
  });
  const wss = new WebSocketServer({server,maxPayload:2048});
  wss.on('connection', hub.register);
  async function close() {
    await hub.close();
    await new Promise(resolve=>wss.close(resolve));
    if(server.listening) await new Promise(resolve=>server.close(resolve));
  }
  return {server,rooms:store.rooms,store,hub,close};
}
if(require.main===module){
  const app=createGameServer(),port=Number(process.env.PORT)||3000;
  app.server.on('error',error=>{console.error(`서버 시작 실패: ${error.message}`);app.close().finally(()=>process.exit(1));});
  app.server.listen(port,'0.0.0.0',()=>{
    console.log(`지렁이 정원: http://localhost:${port}`);
    for(const list of Object.values(os.networkInterfaces()))for(const ip of list||[])
      if(ip.family==='IPv4'&&!ip.internal)console.log(`같은 Wi-Fi 친구 초대: http://${ip.address}:${port}/?room=GARDEN`);
  });
  process.once('SIGINT',()=>app.close().then(()=>process.exit(0)));
  process.once('SIGTERM',()=>app.close().then(()=>process.exit(0)));
}
module.exports={createGameServer};
