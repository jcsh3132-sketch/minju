const { randomUUID } = require('node:crypto');
const { World } = require('./world');

const ROOM_TTL_MS = 120000;
const PLAYER_GRACE_MS = 15000;

function freshRoom() {
  return { world: new World(), updatedAt: Date.now(), revision: 0 };
}
function advanceRoom(room, now, inputs) {
  for (const input of inputs) {
    const player = room.world.players.get(input.id);
    if (!player || player.connection !== input.connection) continue;
    player.lastSeen = now;
    if (input.angle !== null) room.world.input(input.id, input.angle, input.boost);
  }
  for (const [id, player] of room.world.players) {
    if (now - player.lastSeen > PLAYER_GRACE_MS) room.world.players.delete(id);
  }
  const elapsed = Math.max(0, Math.min(250, now - room.updatedAt));
  const steps = Math.floor(elapsed / (1000 / 30));
  for (let i = 0; i < steps; i++) room.world.step(1 / 30);
  room.updatedAt = now - (elapsed - steps * (1000 / 30));
}
function serialize(room) {
  return JSON.stringify({ updatedAt: room.updatedAt, revision: room.revision,
    tick: room.world.tick, nextFoodId: room.world.nextFoodId,
    food: room.world.food, players: [...room.world.players] });
}
function deserialize(raw) {
  if (!raw) return freshRoom();
  const data = JSON.parse(raw), world = Object.create(World.prototype);
  Object.assign(world, { random: Math.random, tick: data.tick, nextFoodId: data.nextFoodId,
    food: data.food, players: new Map(data.players) });
  return { world, updatedAt: data.updatedAt, revision: data.revision };
}
function packet(room, code) {
  return { ...room.world.snapshot(code), revision: room.revision };
}

class MemoryRoomStore {
  constructor() { this.rooms = new Map(); }
  async mutate(code, update) {
    for (const [key, old] of this.rooms) if (Date.now() - old.updatedAt > ROOM_TTL_MS) this.rooms.delete(key);
    let room = this.rooms.get(code);
    if (!room) {
      if (this.rooms.size >= 100) throw new Error('정원이 가득 찼어요. 잠시 뒤 다시 시도해 주세요.');
      room = freshRoom();
    }
    const result = update(room);
    room.revision++;
    if (room.world.players.size) this.rooms.set(code, room);
    else this.rooms.delete(code);
    return { result, snapshot: packet(room, code) };
  }
  async advance(code, inputs) {
    return this.mutate(code, room => advanceRoom(room, Date.now(), inputs));
  }
  async close() {}
}

// Compare-and-swap writes use a fresh UUID, including after a room is recreated.
// A server can only save the exact version it read, preventing lost updates.
class TursoRoomStore {
  constructor(url, authToken, options = {}) {
    const {createClient} = require('@libsql/client/http');
    this.client = createClient({url,authToken});
    this.prefix = options.prefix || 'garden:';
    this.ready = null; this.lastCleanup = 0;
  }
  async initialize() {
    if (!this.ready) this.ready = this.client.execute(`CREATE TABLE IF NOT EXISTS worm_rooms (
      id TEXT PRIMARY KEY, etag TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`).catch(error=>{this.ready=null;throw error;});
    await this.ready;
    if(Date.now()-this.lastCleanup>60000){
      this.lastCleanup=Date.now();
      await this.client.execute({sql:'DELETE FROM worm_rooms WHERE expires_at < ?',args:[Date.now()]});
    }
  }
  async mutate(code, update, {wait=true}={}) {
    await this.initialize();
    const key=this.prefix+code, deadline=Date.now()+(wait?5000:0);
    do {
      const found=await this.client.execute({sql:'SELECT etag,state,expires_at FROM worm_rooms WHERE id = ?',args:[key]});
      const previous=found.rows[0];
      const room=previous&&Number(previous.expires_at)>Date.now()?deserialize(previous.state):freshRoom();
      const result=update(room);room.revision++;
      const etag=randomUUID(),state=serialize(room),expiry=Date.now()+ROOM_TTL_MS;
      let saved;
      if(!room.world.players.size){
        if(!previous)return {result,snapshot:packet(room,code)};
        saved=await this.client.execute({sql:'DELETE FROM worm_rooms WHERE id = ? AND etag = ?',args:[key,previous.etag]});
      }else if(previous){
        saved=await this.client.execute({sql:'UPDATE worm_rooms SET etag = ?,state = ?,expires_at = ? WHERE id = ? AND etag = ?',args:[etag,state,expiry,key,previous.etag]});
      }else{
        saved=await this.client.execute({sql:'INSERT OR IGNORE INTO worm_rooms (id,etag,state,expires_at) VALUES (?,?,?,?)',args:[key,etag,state,expiry]});
      }
      if(saved.rowsAffected===1)return {result,snapshot:packet(room,code)};
      if(!wait)return null;
      await new Promise(resolve=>setTimeout(resolve,20+Math.random()*25));
    }while(Date.now()<deadline);
    throw new Error('정원 연결이 잠시 바빠요. 다시 시도해 주세요.');
  }
  async advance(code,inputs) {
    return this.mutate(code,room=>advanceRoom(room,Date.now(),inputs),{wait:false});
  }
  async close(){this.client.close();}
}
function createRoomStore() {
  if(process.env.TURSO_DATABASE_URL&&process.env.TURSO_AUTH_TOKEN)
    return new TursoRoomStore(process.env.TURSO_DATABASE_URL,process.env.TURSO_AUTH_TOKEN);
  if(process.env.VERCEL)throw new Error('Turso environment variables are required for deployed multiplayer.');
  return new MemoryRoomStore();
}
module.exports={MemoryRoomStore,TursoRoomStore,createRoomStore,advanceRoom,serialize,deserialize};
