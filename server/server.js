// SKULP multiplayer server
// Authoritative simulation: drifty movement, bone pickup, automatic contact
// stealing/biting, hearts, death, respawn, plus anti-cheat enforcement.
// Exposes 4 independent "servers" (rooms) on one process, plus a small HTTP
// API the client's server browser uses to list rooms, player counts, ping.

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 4000;

// If you set ALLOWED_ORIGIN (e.g. to your Netlify URL) as an environment
// variable on your host, only that origin will be allowed to connect from a
// browser. Left as '*' by default so this works out of the box.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const app = express();
app.set('trust proxy', true);
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGIN, methods: ['GET', 'POST'] },
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ARENA = { width: 6000, height: 6000 };
const TICK_HZ = 30;
const TICK_MS = 1000 / TICK_HZ;
const BROADCAST_HZ = 20;
const BROADCAST_MS = 1000 / BROADCAST_HZ;
const MAX_PLAYERS_PER_ROOM = 40;
const PLAYER_RADIUS = 22;

// Drift movement: players accelerate toward their input direction and slide
// when they let off, instead of snapping straight to a target velocity.
// Since the server owns these constants and the client only ever sends a
// direction vector (not a speed), there is no message a modified client can
// send that makes a player move faster than MAX_SPEED allows.
const ACCEL = 1400; // units/sec^2
const MAX_SPEED = 320; // units/sec
const DRIFT_DECAY_PER_SEC = 0.055;

const BONE_RADIUS = 14;
const BONE_TARGET_COUNT = 180;
const BONE_RESPAWN_MS = 4000;

const BITE_RANGE = 62;
const BITE_COOLDOWN_MS = 650;
const BITE_ARC_DEG = 130;

const HEART_MAX = 3;
const RESPAWN_INVULN_MS = 1800;
const MAX_NAME_LEN = 14;

const ROOM_NAMES = [
  'Junkyard Prime',
  'Rustbelt Court',
  'The Bonepit',
  'Alley Howl',
];

const HAT_IDS = ['none', 'party', 'crown', 'bandana', 'halo', 'tinfoil'];

// Only these exact hex values (the swatches offered in the Decorations
// screen) are accepted as a coat color. Anything else - a custom/edited hex
// value sent by a modified client - gets the connection rejected outright.
const APPROVED_COLORS = new Set([
  '#d97757', '#4a90d9', '#5fbf6f', '#c23b3b', '#e8a33d',
  '#8e6bb5', '#3a3a3a', '#efe6d4', '#2f3fd9', '#d93fa0',
]);

// ---------------------------------------------------------------------------
// Anti-cheat thresholds
// ---------------------------------------------------------------------------

// "Give yourself bones" patch: a legitimate player physically can't pick up
// more than a handful of bones in a few seconds given movement speed and
// bone spacing. If a player's pickup rate blows past this, it's either a
// packet-replay/speed exploit or a modified client granting bones directly -
// either way, they're removed.
const BONE_CHEAT_WINDOW_MS = 3000;
const BONE_CHEAT_MAX = 7;

// Generic flood guard on movement input packets. The real client sends ~20/
// sec; this allows a generous buffer above that before treating it as a
// modified client hammering the socket.
const INPUT_FLOOD_WINDOW_MS = 1000;
const INPUT_FLOOD_MAX = 60;

// Basic per-IP join throttle to blunt "spin up dozens of bot connections to
// fill a server" attempts. Honest limitation: players behind the same NAT/
// shared IP (school, office, some mobile carriers) share this budget too, so
// it's deliberately generous rather than a hard wall.
const JOIN_WINDOW_MS = 30000;
const JOIN_MAX_PER_IP = 8;
const joinTimestampsByIp = new Map();

// Anyone kicked for an anti-cheat violation has their IP temporarily
// blocked from reconnecting at all, closing the "get kicked, immediately
// reconnect, keep farming" loophole.
const CHEAT_BAN_MS = 10 * 60 * 1000; // 10 minutes
const bannedIpsUntil = new Map();

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function randRange(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Stray Dog';
  const trimmed = raw.replace(/[^\w \-'!?]/g, '').trim().slice(0, MAX_NAME_LEN);
  return trimmed.length ? trimmed : 'Stray Dog';
}

function isApprovedColor(raw) {
  return typeof raw === 'string' && APPROVED_COLORS.has(raw.toLowerCase());
}

function sanitizeHat(raw) {
  return HAT_IDS.includes(raw) ? raw : 'none';
}

function getClientIp(socket) {
  const xff = socket.handshake.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return socket.handshake.address;
}

function isJoinRateOk(ip) {
  const now = Date.now();
  const arr = (joinTimestampsByIp.get(ip) || []).filter((t) => now - t <= JOIN_WINDOW_MS);
  arr.push(now);
  joinTimestampsByIp.set(ip, arr);
  return arr.length <= JOIN_MAX_PER_IP;
}

function isIpBanned(ip) {
  const until = bannedIpsUntil.get(ip);
  return typeof until === 'number' && Date.now() < until;
}

function banIp(ip) {
  bannedIpsUntil.set(ip, Date.now() + CHEAT_BAN_MS);
}

function kickSocket(socket, room, reason) {
  const ip = getClientIp(socket);
  banIp(ip);
  console.log(`[anti-cheat] kicking ${socket.id} (${ip}) from ${room ? room.id : '?'}: ${reason} - banned for ${CHEAT_BAN_MS / 60000}min`);
  socket.emit('kicked', { reason: 'Removed for suspicious activity.' });
  if (room) room.removePlayer(socket.id);
  socket.disconnect(true);
}

// ---------------------------------------------------------------------------
// Room / game state
// ---------------------------------------------------------------------------

class Room {
  constructor(id, index) {
    this.id = id;
    this.name = ROOM_NAMES[index] || `Server ${index + 1}`;
    this.players = new Map(); // socket.id -> player
    this.bones = new Map(); // bone.id -> bone
    this.nextBoneId = 1;
    for (let i = 0; i < BONE_TARGET_COUNT; i++) this.spawnBone();
  }

  spawnBone() {
    const id = 'b' + this.nextBoneId++;
    const bone = {
      id,
      x: randRange(BONE_RADIUS * 2, ARENA.width - BONE_RADIUS * 2),
      y: randRange(BONE_RADIUS * 2, ARENA.height - BONE_RADIUS * 2),
    };
    this.bones.set(id, bone);
    return bone;
  }

  addPlayer(socketId, name, color, hat) {
    const player = {
      id: socketId,
      name,
      color,
      hat,
      x: randRange(200, ARENA.width - 200),
      y: randRange(200, ARENA.height - 200),
      vx: 0,
      vy: 0,
      dx: 0,
      dy: 0,
      facing: 0, // radians
      hearts: HEART_MAX,
      bones: 0,
      alive: true,
      lastBiteAt: 0,
      invulnUntil: Date.now() + RESPAWN_INVULN_MS,
      kills: 0,
      boneTimestamps: [], // anti-cheat: rolling pickup-rate window
      inputTimestamps: [], // anti-cheat: rolling input-flood window
    };
    this.players.set(socketId, player);
    return player;
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
  }

  respawn(player) {
    player.x = randRange(200, ARENA.width - 200);
    player.y = randRange(200, ARENA.height - 200);
    player.vx = 0;
    player.vy = 0;
    player.hearts = HEART_MAX;
    player.bones = 0;
    player.alive = true;
    player.invulnUntil = Date.now() + RESPAWN_INVULN_MS;
  }

  dropBonesAt(x, y, count) {
    for (let i = 0; i < count; i++) {
      const id = 'b' + this.nextBoneId++;
      const angle = Math.random() * Math.PI * 2;
      const dist = randRange(10, 90);
      this.bones.set(id, {
        id,
        x: clamp(x + Math.cos(angle) * dist, BONE_RADIUS, ARENA.width - BONE_RADIUS),
        y: clamp(y + Math.sin(angle) * dist, BONE_RADIUS, ARENA.height - BONE_RADIUS),
      });
    }
  }

  // Returns { events, kicks } - events for chat toasts, kicks for players
  // the anti-cheat system wants removed this tick.
  tick(dtSec) {
    this._moveAndDrift(dtSec);
    const kicks = this._pickUpBones();

    if (this.bones.size < BONE_TARGET_COUNT / 2) {
      this.spawnBone();
    }

    const events = this._autoBiteSweep();
    return { events, kicks };
  }

  _moveAndDrift(dtSec) {
    const decayFactor = Math.max(0, 1 - DRIFT_DECAY_PER_SEC * 60 * dtSec);
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const mag = Math.hypot(p.dx, p.dy);

      if (mag > 0.001) {
        const nx = p.dx / mag;
        const ny = p.dy / mag;
        p.vx += nx * ACCEL * dtSec;
        p.vy += ny * ACCEL * dtSec;
        p.facing = Math.atan2(ny, nx);
      } else {
        p.vx *= decayFactor;
        p.vy *= decayFactor;
      }

      const speed = Math.hypot(p.vx, p.vy);
      if (speed > MAX_SPEED) {
        p.vx = (p.vx / speed) * MAX_SPEED;
        p.vy = (p.vy / speed) * MAX_SPEED;
      }

      let nextX = p.x + p.vx * dtSec;
      let nextY = p.y + p.vy * dtSec;
      if (nextX < PLAYER_RADIUS || nextX > ARENA.width - PLAYER_RADIUS) p.vx = 0;
      if (nextY < PLAYER_RADIUS || nextY > ARENA.height - PLAYER_RADIUS) p.vy = 0;
      p.x = clamp(nextX, PLAYER_RADIUS, ARENA.width - PLAYER_RADIUS);
      p.y = clamp(nextY, PLAYER_RADIUS, ARENA.height - PLAYER_RADIUS);
    }
  }

  _pickUpBones() {
    const now = Date.now();
    const kicks = [];
    const kickedThisPass = new Set();

    for (const p of this.players.values()) {
      if (!p.alive || kickedThisPass.has(p.id)) continue;
      let pickedUpThisTick = 0;

      for (const bone of this.bones.values()) {
        const d = Math.hypot(p.x - bone.x, p.y - bone.y);
        if (d < PLAYER_RADIUS + BONE_RADIUS) {
          this.bones.delete(bone.id);
          p.bones += 1;
          pickedUpThisTick += 1;

          p.boneTimestamps.push(now);
          p.boneTimestamps = p.boneTimestamps.filter((t) => now - t <= BONE_CHEAT_WINDOW_MS);

          setTimeout(() => {
            if (this.players.size > 0) this.spawnBone();
          }, BONE_RESPAWN_MS);

          // A legitimate player's hitbox can only ever realistically reach
          // a bone or two per single server tick given movement speed and
          // bone spacing. Grabbing a burst far beyond that in one tick is
          // an instant tell (teleport/hitbox exploit) - don't wait for the
          // rolling window, kick immediately.
          if (pickedUpThisTick > 3) {
            kicks.push({ id: p.id, reason: 'single-tick bone burst' });
            kickedThisPass.add(p.id);
            break;
          }
        }
      }

      if (!kickedThisPass.has(p.id) && p.boneTimestamps.length > BONE_CHEAT_MAX) {
        kicks.push({ id: p.id, reason: 'bone pickup rate exceeded' });
        kickedThisPass.add(p.id);
      }
    }
    return kicks;
  }

  _autoBiteSweep() {
    const now = Date.now();
    const events = [];

    for (const attacker of this.players.values()) {
      if (!attacker.alive) continue;
      if (now - attacker.lastBiteAt < BITE_COOLDOWN_MS) continue;

      let target = null;
      let bestDist = Infinity;
      for (const p of this.players.values()) {
        if (p.id === attacker.id || !p.alive) continue;
        if (now < p.invulnUntil) continue;
        const dx = p.x - attacker.x;
        const dy = p.y - attacker.y;
        const dist = Math.hypot(dx, dy);
        if (dist > BITE_RANGE) continue;
        const angleToTarget = Math.atan2(dy, dx);
        let diff = Math.abs(angleToTarget - attacker.facing);
        if (diff > Math.PI) diff = Math.PI * 2 - diff;
        if (diff > (BITE_ARC_DEG * Math.PI) / 180 / 2) continue;
        if (dist < bestDist) {
          bestDist = dist;
          target = p;
        }
      }
      if (!target) continue;

      attacker.lastBiteAt = now;

      if (target.bones > 0) {
        target.bones -= 1;
        attacker.bones += 1;
        events.push({ type: 'steal', attacker: attacker.name, target: target.name });
        continue;
      }

      target.hearts -= 1;
      if (target.hearts <= 0) {
        const droppedBones = target.bones;
        target.alive = false;
        target.bones = 0;
        this.dropBonesAt(target.x, target.y, droppedBones);
        attacker.kills += 1;
        setTimeout(() => {
          if (this.players.has(target.id)) this.respawn(target);
        }, 1600);
        events.push({ type: 'kill', attacker: attacker.name, target: target.name });
      } else {
        events.push({ type: 'hit', attacker: attacker.name, target: target.name });
      }
    }

    return events;
  }

  snapshot() {
    return {
      arena: ARENA,
      players: Array.from(this.players.values()).map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        hat: p.hat,
        x: Math.round(p.x),
        y: Math.round(p.y),
        facing: Math.round(p.facing * 100) / 100,
        hearts: p.hearts,
        bones: p.bones,
        alive: p.alive,
        invuln: Date.now() < p.invulnUntil,
        kills: p.kills,
      })),
      bones: Array.from(this.bones.values()),
    };
  }
}

const rooms = new Map();
for (let i = 0; i < 4; i++) {
  const id = `server-${i + 1}`;
  rooms.set(id, new Room(id, i));
}

// ---------------------------------------------------------------------------
// HTTP API - server browser + ping probe
// ---------------------------------------------------------------------------

app.get('/api/servers', (req, res) => {
  const list = Array.from(rooms.values()).map((r) => ({
    id: r.id,
    name: r.name,
    players: r.players.size,
    maxPlayers: MAX_PLAYERS_PER_ROOM,
  }));
  res.json({ servers: list });
});

app.get('/api/ping', (req, res) => {
  res.json({ t: Date.now() });
});

app.get('/', (req, res) => {
  res.send('SKULP backend is running.');
});

// ---------------------------------------------------------------------------
// Socket.io - realtime gameplay
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  let currentRoomId = null;

  socket.on('join', (payload, ack) => {
    const ip = getClientIp(socket);

    if (isIpBanned(ip)) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Your network is temporarily blocked due to prior suspicious activity.' });
      }
      socket.disconnect(true);
      return;
    }

    if (!isJoinRateOk(ip)) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Too many join attempts from your network. Please wait a moment and try again.' });
      }
      socket.disconnect(true);
      return;
    }

    const roomId = typeof payload?.room === 'string' ? payload.room : null;
    const room = rooms.get(roomId);
    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Server not found.' });
      return;
    }
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
      if (typeof ack === 'function') ack({ ok: false, error: 'That server is full.' });
      return;
    }

    // Anti-cheat: coat color must be one of the exact approved swatches.
    // A custom/edited value here means a tampered client - refuse the
    // connection outright rather than silently correcting it.
    if (!isApprovedColor(payload?.color)) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Invalid cosmetic color detected. Connection refused.' });
      }
      console.log(`[anti-cheat] rejected join from ${socket.id} (${ip}): invalid color`);
      socket.disconnect(true);
      return;
    }

    const name = sanitizeName(payload?.name);
    const color = payload.color.toLowerCase();
    const hat = sanitizeHat(payload?.hat);

    room.addPlayer(socket.id, name, color, hat);
    socket.join(roomId);
    currentRoomId = roomId;

    if (typeof ack === 'function') {
      ack({ ok: true, selfId: socket.id, arena: ARENA, roomName: room.name });
    }
    socket.emit('state', room.snapshot());
  });

  socket.on('input', (payload) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    const now = Date.now();
    player.inputTimestamps.push(now);
    player.inputTimestamps = player.inputTimestamps.filter((t) => now - t <= INPUT_FLOOD_WINDOW_MS);
    if (player.inputTimestamps.length > INPUT_FLOOD_MAX) {
      kickSocket(socket, room, 'input flooding');
      return;
    }

    const dx = clamp(Number(payload?.dx) || 0, -1, 1);
    const dy = clamp(Number(payload?.dy) || 0, -1, 1);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    player.dx = dx;
    player.dy = dy;
  });

  socket.on('ping-probe', (_payload, ack) => {
    if (typeof ack === 'function') ack(Date.now());
  });

  socket.on('disconnect', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (room) room.removePlayer(socket.id);
  });
});

// ---------------------------------------------------------------------------
// Game loop
// ---------------------------------------------------------------------------

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dtSec = (now - lastTick) / 1000;
  lastTick = now;
  for (const room of rooms.values()) {
    if (room.players.size === 0) continue;
    const { events, kicks } = room.tick(dtSec);
    events.forEach((ev) => io.to(room.id).emit('event', ev));
    kicks.forEach(({ id, reason }) => {
      const s = io.sockets.sockets.get(id);
      if (s) kickSocket(s, room, reason);
      else room.removePlayer(id);
    });
  }
}, TICK_MS);

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.players.size === 0) continue;
    io.to(room.id).emit('state', room.snapshot());
  }
}, BROADCAST_MS);

// Periodically forget old join-rate history and expired bans so these maps
// don't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of joinTimestampsByIp.entries()) {
    const fresh = arr.filter((t) => now - t <= JOIN_WINDOW_MS);
    if (fresh.length === 0) joinTimestampsByIp.delete(ip);
    else joinTimestampsByIp.set(ip, fresh);
  }
  for (const [ip, until] of bannedIpsUntil.entries()) {
    if (now >= until) bannedIpsUntil.delete(ip);
  }
}, 60000);

server.listen(PORT, () => {
  console.log(`SKULP server listening on port ${PORT}`);
});
