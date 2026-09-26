const { randomUUID, randomBytes, timingSafeEqual } = require('node:crypto');
const { WebSocket } = require('ws');
const { advanceRoom } = require('./room-store');
const validRoom = room => typeof room === 'string' && /^[A-Z0-9-]{3,12}$/.test(room);
function tokenMatches(a, b) {
  return typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function createGameHub(store) {
  const clients = new Set(), busyRooms = new Set();
  let ticking = null, heartbeat = null;
  const send = (ws, data) => {
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 256000) ws.send(JSON.stringify(data));
  };
  function sendState(ws, data) {
    if (data.room !== ws.room || (ws.revision ?? -1) >= data.revision) return;
    ws.revision = data.revision; send(ws, data);
  }
  async function leave(ws, remove = true) {
    const code = ws.room;
    ws.room = null; ws.revision = -1; ws.input = null;
    if (remove && code) await store.mutate(code, room => {
      const p = room.world.players.get(ws.id);
      if (p?.connection === ws.connectionId) room.world.players.delete(ws.id);
    });
  }
  function report(ws, error) {
    const known = /[가-힣]/.test(error.message || '');
    send(ws, { type: 'error', code: error.code || 'SERVER_BUSY',
      message: known ? error.message : '정원 서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.' });
    if (!known) console.error('[garden]', error.code || error.name || 'server error');
  }
  async function join(ws, data) {
    const code = typeof data.room === 'string' ? data.room.trim().toUpperCase() : '';
    if (!validRoom(code)) throw new Error('방 코드는 영문·숫자 3~12자로 입력해 주세요.');
    if (ws.room && ws.room !== code) await leave(ws);
    const name = typeof data.name === 'string' ? data.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 14) : '';
    const token = randomBytes(32).toString('hex');
    const updated = await store.mutate(code, room => {
      advanceRoom(room, Date.now(), []);
      const current = room.world.players.get(ws.id);
      if (current?.alive) return { token: current.token, id: ws.id };
      if (room.world.players.size >= 12 && !current) throw Object.assign(new Error('방이 가득 찼어요. 다른 방 코드를 입력해 주세요.'),{code:'ROOM_FULL'});
      const p = room.world.spawn(ws.id, name || '말랑이', Number.isInteger(data.color) ? data.color : 0);
      p.token = token; p.connection = ws.connectionId; p.lastSeen = Date.now();
      return { token, id: ws.id };
    });
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.room = code; ws.revision = -1; ws.input = null;
    send(ws, { type: 'joined', room: code, ...updated.result }); sendState(ws, updated.snapshot);
  }
  async function match(ws,data){
    // Every instance uses the same candidate order; atomic joins enforce capacity.
    const occupied=await store.publicRooms();
    const candidates=[...new Set([...(ws.room?[ws.room]:[]),...occupied,'GARDEN',
      ...Array.from({length:99},(_,i)=>'PUBLIC-'+(i+2))])];
    for(const room of candidates){
      try{await join(ws,{...data,room});return;}
      catch(error){if(error.code!=='ROOM_FULL')throw error;}
    }
    throw new Error('모든 정원이 가득 찼어요. 잠시 후 다시 참여해 주세요.');
  }
  async function resume(ws, data) {
    if (!validRoom(data.room) || typeof data.id !== 'string') throw Object.assign(new Error('이전 산책이 끝났어요. 다시 입장해 주세요.'), {code:'RESUME_EXPIRED'});
    const updated = await store.mutate(data.room, room => {
      const p = room.world.players.get(data.id);
      if (!p || Date.now() - p.lastSeen > 15000 || !tokenMatches(p.token, data.token))
        throw Object.assign(new Error('이전 산책이 끝났어요. 다시 입장해 주세요.'), {code:'RESUME_EXPIRED'});
      p.connection = ws.connectionId; p.lastSeen = Date.now(); p.boosting = false;
    });
    ws.id = data.id; ws.room = data.room; ws.revision = -1;
    send(ws, {type:'joined',id:ws.id,room:ws.room,token:data.token,resumed:true}); sendState(ws, updated.snapshot);
  }
  async function tick() {
    const active = new Map();
    for (const ws of clients) if (ws.room && ws.readyState === WebSocket.OPEN) {
      if (!active.has(ws.room)) active.set(ws.room, []);
      active.get(ws.room).push(ws);
    }
    await Promise.all([...active].map(async ([code, sockets]) => {
      if (busyRooms.has(code)) return;
      busyRooms.add(code);
      try {
        const result = await store.advance(code, sockets.map(ws => ({id:ws.id,connection:ws.connectionId,
          angle:ws.input?.angle ?? null,boost:ws.input?.boost ?? false})));
        if (result) for (const ws of sockets) sendState(ws, result.snapshot);
      } catch (error) {
        for (const ws of sockets) {
          if (Date.now()-(ws.lastError||0)>5000) {ws.lastError=Date.now();report(ws,error);}
        }
      } finally { busyRooms.delete(code); }
    }));
  }
  function start() {
    if (ticking) return;
    ticking = setInterval(() => void tick(), 1000/15); ticking.unref?.();
    heartbeat = setInterval(() => {
      for (const ws of clients) {
        if (!ws.isAlive) {ws.terminate();continue;}
        ws.isAlive=false;ws.ping();
      }
    }, 10000); heartbeat.unref?.();
  }
  function stop() {clearInterval(ticking);clearInterval(heartbeat);ticking=null;heartbeat=null;}
  function register(ws) {
    ws.id=randomUUID();ws.connectionId=randomUUID();ws.room=null;ws.input=null;ws.isAlive=true;
    ws.budget=0;ws.window=Date.now();ws.revision=-1;ws.queue=Promise.resolve();
    clients.add(ws);start();send(ws,{type:'hello',id:ws.id});
    ws.on('pong',()=>{ws.isAlive=true;});
    ws.on('message',raw=>{
      if(Date.now()-ws.window>=1000){ws.window=Date.now();ws.budget=0;}
      if(++ws.budget>60)return;
      let data;try{data=JSON.parse(raw.toString());}catch{return;}
      if(!data||typeof data!=='object')return;
      if(data.type==='input'){
        if(typeof data.angle==='number'&&Number.isFinite(data.angle))ws.input={angle:data.angle,boost:data.boost===true};
        return;
      }
      if(!['join','match','resume','leave'].includes(data.type))return;
      ws.queue=ws.queue.then(async()=>{
        if(ws.readyState!==WebSocket.OPEN)return;
        if(data.type==='join')await join(ws,data);
        else if(data.type==='match')await match(ws,data);
        else if(data.type==='resume')await resume(ws,data);
        else{await leave(ws);send(ws,{type:'left'});}
      }).catch(error=>report(ws,error));
    });
    ws.on('close',()=>{
      clients.delete(ws);void leave(ws,false);
      if(!clients.size)stop();
    });
    ws.on('error',()=>ws.terminate());
    // Renew before the Function duration limit; reconnects retain the player.
    if(process.env.VERCEL){
      const renewal=setTimeout(()=>ws.close(1012,'connection renewal'),270000);renewal.unref?.();
      ws.once('close',()=>clearTimeout(renewal));
    }
  }
  async function close(){stop();for(const ws of clients)ws.terminate();await store.close();}
  return {register,close,clients};
}
module.exports={createGameHub};
