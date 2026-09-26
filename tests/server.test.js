const test=require('node:test');
const assert=require('node:assert/strict');
const {WebSocket}=require('ws');
const {createGameServer}=require('../server');

function client(url){
  const socket=new WebSocket(url),messages=[],waiters=[];
  socket.on('message',raw=>{
    const data=JSON.parse(raw.toString()),index=waiters.findIndex(w=>w.predicate(data));
    if(index>=0){const w=waiters.splice(index,1)[0];clearTimeout(w.timer);w.resolve(data);}else messages.push(data);
  });
  function next(predicate){
    const index=messages.findIndex(predicate);if(index>=0)return Promise.resolve(messages.splice(index,1)[0]);
    return new Promise((resolve,reject)=>{
      const waiter={predicate,resolve,timer:setTimeout(()=>{const i=waiters.indexOf(waiter);if(i>=0)waiters.splice(i,1);reject(new Error('Timed out waiting for server packet'));},2500)};
      waiters.push(waiter);
    });
  }
  return {socket,next,send:data=>socket.send(JSON.stringify(data))};
}
test('real clients synchronize, isolate rooms, respawn and clean up',async t=>{
  const app=createGameServer();await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(base)).status,200);assert.equal((await fetch(base+'/world.js')).status,404);
  assert.equal((await fetch(base+'/__proto__')).status,404);
  const a=client(base.replace('http','ws')+'/play'),b=client(base.replace('http','ws')+'/play'),c=client(base.replace('http','ws')+'/play');
  const [helloA,helloB]=await Promise.all([a.next(d=>d.type==='hello'),b.next(d=>d.type==='hello'),c.next(d=>d.type==='hello')]);
  a.socket.send('{bad json');a.send({type:'join',room:'!',name:'Invalid'});
  assert.equal((await a.next(d=>d.type==='error')).type,'error');
  a.send({type:'join',room:'TEST',name:'Alice',color:0});b.send({type:'join',room:'TEST',name:'Bob',color:1});c.send({type:'join',room:'OTHER',name:'Carol'});
  await Promise.all([a.next(d=>d.type==='joined'),b.next(d=>d.type==='joined'),c.next(d=>d.type==='joined')]);
  const stateA=await a.next(d=>d.type==='state'&&d.players.length===2);
  const stateB=await b.next(d=>d.type==='state'&&d.players.length===2&&d.revision===stateA.revision);
  assert.deepEqual(stateA,stateB);
  const stateC=await c.next(d=>d.type==='state');assert.equal(stateC.players.length,1);assert.equal(stateC.room,'OTHER');
  assert.deepEqual(new Set(stateA.players.map(p=>p.name)),new Set(['Alice','Bob']));
  const room=app.rooms.get('TEST'),player=room.world.players.get(helloA.id);
  a.send({type:'input',angle:1,boost:true});
  await a.next(d=>d.type==='state'&&d.players.some(p=>p.id===helloA.id&&p.energy<100));
  assert.equal(player.target,1);
  player.body[0]={x:1435,y:450};player.angle=0;player.target=0;
  await a.next(d=>d.type==='state'&&d.players.some(p=>p.id===helloA.id&&!p.alive));
  a.send({type:'join',room:'TEST',name:'Alice',color:2});await a.next(d=>d.type==='joined');
  const respawn=await a.next(d=>d.type==='state'&&d.players.some(p=>p.id===helloA.id&&p.alive&&p.color==='#80cbb8'));
  assert.equal(respawn.players.length,2);
  b.socket.close();
  await new Promise(resolve=>b.socket.once('close',resolve));
  room.world.players.get(helloB.id).lastSeen=Date.now()-16000;
  await a.next(d=>d.type==='state'&&d.revision>respawn.revision&&d.players.length===1);
  assert.equal(room.world.players.has(helloB.id),false);
  a.send({type:'leave'});await a.next(d=>d.type==='left');assert.equal(app.rooms.has('TEST'),false);
  c.send({type:'leave'});await c.next(d=>d.type==='left');assert.equal(app.rooms.size,0);
});

test('reconnection restores the same player only with the secret resume token',async t=>{
  const app=createGameServer();await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const url=`ws://127.0.0.1:${app.server.address().port}/play`;
  const first=client(url);await first.next(d=>d.type==='hello');first.send({type:'join',room:'RESUME',name:'Traveler'});
  const joined=await first.next(d=>d.type==='joined');
  const original=app.rooms.get('RESUME').world.players.get(joined.id);original.score=90;
  first.socket.close();await new Promise(resolve=>first.socket.once('close',resolve));
  const next=client(url);await next.next(d=>d.type==='hello');
  next.send({type:'resume',room:'RESUME',id:joined.id,token:'0'.repeat(64)});
  assert.equal((await next.next(d=>d.type==='error')).code,'RESUME_EXPIRED');
  next.send({type:'resume',room:'RESUME',id:joined.id,token:joined.token});
  const rejoined=await next.next(d=>d.type==='joined');assert.equal(rejoined.id,joined.id);
  const state=await next.next(d=>d.type==='state');assert.equal(state.players[0].score,90);
  assert.equal(JSON.stringify(state).includes(joined.token),false);
});

test('public matchmaking fills rooms, overflows safely and prefers active rooms',async t=>{
  const app=createGameServer();await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const url=`ws://127.0.0.1:${app.server.address().port}/play`;
  const people=Array.from({length:13},()=>client(url));
  await Promise.all(people.map(p=>p.next(d=>d.type==='hello')));
  people.forEach((p,i)=>p.send({type:'match',name:'Guest'+i}));
  const joins=await Promise.all(people.map(p=>p.next(d=>d.type==='joined')));
  assert.equal(joins.filter(p=>p.room==='GARDEN').length,12);
  assert.equal(joins.filter(p=>p.room==='PUBLIC-2').length,1);
  const extra=client(url);await extra.next(d=>d.type==='hello');extra.send({type:'match'});
  assert.equal((await extra.next(d=>d.type==='joined')).room,'PUBLIC-2');
  const publicPlayer=joins.findIndex(p=>p.room==='PUBLIC-2');
  people[publicPlayer].send({type:'match'});
  assert.equal((await people[publicPlayer].next(d=>d.type==='joined')).room,'PUBLIC-2');
});
