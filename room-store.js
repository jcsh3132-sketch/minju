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

// Every mutation is fenced by its unique lock token, so an expired owner cannot
// overwrite a newer room. This also keeps separate Vercel instances in sync.
const LOCK = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', 3000) then
  return {redis.call('GET', KEYS[2]) or ''}
end
return nil`;
const COMMIT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == '' then redis.call('DEL', KEYS[2])
else redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3]) end
redis.call('DEL', KEYS[1])
return 1`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

class RedisRoomStore {
  constructor(url, options = {}) {
    const Redis = require('ioredis');
    this.redis = new Redis(url, { lazyConnect: true, connectTimeout: 5000,
      maxRetriesPerRequest: 1, retryStrategy: n => Math.min(n * 200, 2000) });
    this.redis.on('error', () => {});
    this.prefix = options.prefix || 'worm-garden:v3:';
  }
  async mutate(code, update, { wait = true } = {}) {
    const stateKey = this.prefix + code, lockKey = stateKey + ':lock';
    const deadline = Date.now() + (wait ? 2400 : 0);
    do {
      const token = randomUUID();
      const locked = await this.redis.eval(LOCK, 2, lockKey, stateKey, token);
      if (locked) {
        try {
          const room = deserialize(locked[0]);
          const result = update(room); room.revision++;
          const saved = await this.redis.eval(COMMIT, 2, lockKey, stateKey, token,
            room.world.players.size ? serialize(room) : '', ROOM_TTL_MS);
          if (saved) return { result, snapshot: packet(room, code) };
        } catch (error) {
          await this.redis.eval(RELEASE, 1, lockKey, token).catch(() => {});
          throw error;
        }
      }
      if (!wait) return null;
      await new Promise(resolve => setTimeout(resolve, 25 + Math.random() * 20));
    } while (Date.now() < deadline);
    throw new Error('정원 연결이 잠시 바빠요. 다시 시도해 주세요.');
  }
  async advance(code, inputs) {
    return this.mutate(code, room => advanceRoom(room, Date.now(), inputs), { wait: false });
  }
  async close() { this.redis.disconnect(); }
}
function createRoomStore() {
  const url = process.env.REDIS_URL || process.env.KV_URL;
  if (url) return new RedisRoomStore(url);
  if (process.env.VERCEL) throw new Error('REDIS_URL is required for deployed multiplayer.');
  return new MemoryRoomStore();
}
module.exports = { MemoryRoomStore, RedisRoomStore, createRoomStore, advanceRoom, serialize, deserialize };
