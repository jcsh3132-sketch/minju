const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {WebSocket} = require('ws');
const {TursoRoomStore} = require('../room-store');
const {createGameServer} = require('../server');

const url = process.env.TURSO_DATABASE_URL;
test('separate server instances share rooms and reconnect state through Turso', {skip:!url,timeout:30000}, async t => {
  const prefix='worm-test:'+randomUUID()+':';
  const token=process.env.TURSO_AUTH_TOKEN;
  const firstStore=new TursoRoomStore(url,token,{prefix}),secondStore=new TursoRoomStore(url,token,{prefix});
  const first=createGameServer({store:firstStore}),second=createGameServer({store:secondStore});
  await Promise.all([first,second].map(app=>new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve))));
  const sockets=[];
  t.after(async()=>{for(const socket of sockets)socket.terminate();await Promise.all([first.close(),second.close()]);});
  function client(app){
    const socket=new WebSocket(`ws://127.0.0.1:${app.server.address().port}/play`),history=[];
    sockets.push(socket);socket.on('message',raw=>history.push(JSON.parse(raw.toString())));
    return {socket,send:data=>socket.send(JSON.stringify(data)),wait:async predicate=>{
      for(let i=0;i<200;i++){
        const index=history.findIndex(predicate);if(index>=0)return history.splice(index,1)[0];
        await new Promise(resolve=>setTimeout(resolve,40));
      }
      throw new Error('Timed out waiting for distributed state');
    }};
  }
  const a=client(first),b=client(second);
  await Promise.all([a,b].map(c=>c.wait(d=>d.type==='hello')));
  a.send({type:'join',room:'CLOUD',name:'First instance'});b.send({type:'join',room:'CLOUD',name:'Second instance'});
  const [joined]=await Promise.all([a,b].map(c=>c.wait(d=>d.type==='joined')));
  const [stateA,stateB]=await Promise.all([a,b].map(c=>c.wait(d=>d.type==='state'&&d.players.length===2)));
  assert.deepEqual(new Set(stateA.players.map(p=>p.id)),new Set(stateB.players.map(p=>p.id)));
  assert.equal(JSON.stringify(stateA).includes(joined.token),false);
  // The first server goes away, and its player resumes on the second instance.
  a.socket.close();await new Promise(resolve=>a.socket.once('close',resolve));
  const resumed=client(second);await resumed.wait(d=>d.type==='hello');
  resumed.send({type:'resume',room:'CLOUD',id:joined.id,token:joined.token});
  const ack=await resumed.wait(d=>d.type==='joined');assert.equal(ack.id,joined.id);
  const shared=await resumed.wait(d=>d.type==='state'&&d.players.length===2);assert.ok(shared.tick>=stateA.tick);
  await Promise.all([resumed,b].map(async c=>{c.send({type:'leave'});await c.wait(d=>d.type==='left');}));
  const remaining=await firstStore.client.execute({sql:'SELECT id FROM worm_rooms WHERE id = ?',args:[prefix+'CLOUD']});
  assert.equal(remaining.rows.length,0);
});
