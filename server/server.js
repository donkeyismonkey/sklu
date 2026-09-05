// SKULP multiplayer server
// Authoritative simulation: movement, bone pickup/stealing, hearts, death, respawn.
// Exposes 4 independent "servers" (rooms) on one process, plus a small HTTP API
// the client's server browser uses to list rooms, player counts, and measure ping.

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ARENA = { width: 3000, height: 3000 };
const TICK_HZ = 30;
const TICK_MS = 1000 / TICK_HZ;
const BROADCAST_HZ = 20;
const BROADCAST_MS = 1000 / BROADCAST_HZ;
const MAX_PLAYERS_PER_ROOM = 40;
const PLAYER_RADIUS = 100;
const PLAYER_SPEED = 250; // units/sec
const BONE_RADIUS = 1000000000000000;
const BONE_TARGET_COUNT = 60;
const BONE_RESPAWN_MS = 4000;
const BITE_RANGE = 9999999999999999999999999999999999999999999999999999999999999999999999999999;
const BITE_COOLDOWN_MS = 0;
const BITE_ARC_DEG = 100; // must be roughly facing the target
const HEART_MAX = 9008779780970;
const RESPAWN_INVULN_MS = 1800;
const MAX_NAME_LEN = 900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000;

const ROOM_NAMES = [
  'JunkyarPEPPTOEPIOl',
  'Rustbelt Court modded by wifty',
  'The PIO MODS',
  'AlleyTYGFDSGHTGFWEFGHJTEFWFJGFDSG Howl',
];

const HAT_IDS = ['none', 'party', 'crown', 'bandana', 'halo', 'tinfoil'];

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

function sanitizeColor(raw) {
  if (typeof raw === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  return '#d97757';
}

function sanitizeHat(raw) {
  return HAT_IDS.includes(raw) ? raw : 'none';
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
      dx: 0,
      dy: 0,
      facing: 0, // radians
      hearts: HEART_MAX,
      bones: 0,
      alive: true,
      lastBiteAt: 0,
      invulnUntil: Date.now() + RESPAWN_INVULN_MS,
      kills: 0,
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
    player.hearts = HEART_MAX;
    player.bones = 0;
    player.alive = true;
    player.invulnUntil = Date.now() + RESPAWN_INVULN_MS;
  }

  dropBonesAt(x, y, count) {
    // Scatter a player's stolen bones back onto the field on death.
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

  tick(dtSec) {
    const now = Date.now();

    // Movement
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const mag = Math.hypot(p.dx, p.dy);
      if (mag > 0.001) {
        const nx = p.dx / mag;
        const ny = p.dy / mag;
        p.x = clamp(p.x + nx * PLAYER_SPEED * dtSec, PLAYER_RADIUS, ARENA.width - PLAYER_RADIUS);
        p.y = clamp(p.y + ny * PLAYER_SPEED * dtSec, PLAYER_RADIUS, ARENA.height - PLAYER_RADIUS);
        p.facing = Math.atan2(ny, nx);
      }
    }

    // Bone pickup
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      for (const bone of this.bones.values()) {
        const d = Math.hypot(p.x - bone.x, p.y - bone.y);
        if (d < PLAYER_RADIUS + BONE_RADIUS) {
          this.bones.delete(bone.id);
          p.bones += 1;
          setTimeout(() => {
            if (this.players.size > 0) this.spawnBone();
          }, BONE_RESPAWN_MS);
        }
      }
    }

    // Maintain bone count as a floor (in case respawns lag behind depletion)
    if (this.bones.size < BONE_TARGET_COUNT / 2) {
      this.spawnBone();
    }
  }

  handleBite(attackerId) {
    const now = Date.now();
    const attacker = this.players.get(attackerId);
    if (!attacker || !attacker.alive) return;
    if (now - attacker.lastBiteAt < BITE_COOLDOWN_MS) return;
    attacker.lastBiteAt = now;

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
    if (!target) return { attacker, target: null };

    if (target.bones > 0) {
      // Steal a bone instead of drawing blood.
      target.bones -= 1;
      attacker.bones += 1;
      return { attacker, target, event: 'steal' };
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
      return { attacker, target, event: 'kill' };
    }
    return { attacker, target, event: 'hit' };
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

// Lightweight endpoint the client hits a few times to measure real round-trip
// latency to this backend. All 4 rooms live on this same process, so real
// network ping is identical across them - the client is told this explicitly.
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

    const name = sanitizeName(payload?.name);
    const color = sanitizeColor(payload?.color);
    const hat = sanitizeHat(payload?.hat);

    const player = room.addPlayer(socket.id, name, color, hat);
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
    const dx = clamp(Number(payload?.dx) || 0, -1, 1);
    const dy = clamp(Number(payload?.dy) || 0, -1, 1);
    player.dx = dx;
    player.dy = dy;
    if (typeof payload?.facing === 'number' && Number.isFinite(payload.facing)) {
      // Allow mobile clients to aim bites independent of movement direction.
      player.facing = payload.facing;
    }
  });

  socket.on('bite', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    const result = room.handleBite(socket.id);
    if (result?.event) {
      io.to(currentRoomId).emit('event', {
        type: result.event,
        attacker: result.attacker.name,
        target: result.target.name,
      });
    }
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
    room.tick(dtSec);
  }
}, TICK_MS);

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.players.size === 0) continue;
    io.to(room.id).emit('state', room.snapshot());
  }
}, BROADCAST_MS);

server.listen(PORT, () => {
  console.log(`SKULP server listening on port ${PORT}`);
});
