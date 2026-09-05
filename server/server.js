// SKULP multiplayer server
// Authoritative simulation: drifty movement, bone pickup/stealing, hearts,
// death, respawn, upgrade pickups, bush hiding, plus anti-cheat enforcement.
// Exposes 4 independent "servers" (rooms) on one process, plus a small HTTP
// API the client's server browser uses to list rooms, player counts, ping,
// and a proof-of-work challenge used to gate joining.

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 4000;

// Bump this on every server deploy. Visit your backend's root URL in a
// browser to see this - if it doesn't match what you just pushed, Render
// is still running an old build, full stop, before anything else is
// investigated.
const SERVER_VERSION = '2026.09.05-3';

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

const ARENA = { width: 9000, height: 9000 };
const TICK_HZ = 30;
const TICK_MS = 1000 / TICK_HZ;
const BROADCAST_HZ = 20;
const BROADCAST_MS = 1000 / BROADCAST_HZ;
const MAX_PLAYERS_PER_ROOM = 40;
const PLAYER_RADIUS = 22;

const ACCEL = 1400; // units/sec^2
const BASE_MAX_SPEED = 320; // units/sec
const SPEED_BOOST_MULTIPLIER = 1.6;
const DRIFT_DECAY_PER_SEC = 0.055;

const BONE_RADIUS = 14;
const BONE_TARGET_COUNT = 260;
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

// Cosmetics offered client-side - kept in sync with client/js/sprites.js.
const HAT_IDS = [
  'none', 'party', 'crown', 'bandana', 'halo', 'tinfoil',
  'sunglasses', 'mohawk', 'wizard', 'viking',
];

const APPROVED_COLORS = new Set([
  '#d97757', '#4a90d9', '#5fbf6f', '#c23b3b', '#e8a33d',
  '#8e6bb5', '#3a3a3a', '#efe6d4', '#2f3fd9', '#d93fa0',
]);

// ---------------------------------------------------------------------------
// Anti-cheat thresholds
// ---------------------------------------------------------------------------

// Raised from earlier, tighter values after real-world testing showed
// legitimate players occasionally scooping several bones at once near a
// death-drop cluster (a dead player's bones scatter close together) could
// trip an overly aggressive limit. These stay far below anything a real
// exploit would produce while giving normal play real headroom.
const BONE_CHEAT_WINDOW_MS = 3000;
const BONE_CHEAT_MAX = 18;
const BONE_CHEAT_SINGLE_TICK_MAX = 8;

const INPUT_FLOOD_WINDOW_MS = 1000;
const INPUT_FLOOD_MAX = 100;

const JOIN_WINDOW_MS = 30000;
const JOIN_MAX_PER_IP = 8;
const joinTimestampsByIp = new Map();

// IMPORTANT FIX: a single kick no longer bans an IP outright - that's what
// caused legitimate players to get banned over one false positive or over
// sharing a network with someone else entirely. An IP is only banned after
// repeated violations in a short window, which is what an actual bot/cheat
// script does and a normal player essentially never does by accident.
const CHEAT_BAN_MS = 10 * 60 * 1000;
const CHEAT_STRIKES_BEFORE_BAN = 3;
const CHEAT_STRIKE_WINDOW_MS = 5 * 60 * 1000;
const cheatStrikesByIp = new Map(); // ip -> [timestamps]
const bannedIpsUntil = new Map();

// Proof-of-work join gate: before joining, the client must fetch a
// short-lived challenge and find a nonce whose SHA-256 hash (challenge +
// nonce) starts with DIFFICULTY_PREFIX. This costs real, unavoidable CPU
// time per join attempt - trivial for one real player, but adds real,
// scaling cost to spinning up many bot connections quickly. It's not full
// user accounts (this project has none), but it's a genuine, working cost
// gate that a page-injected mod menu still has to pay for every bot it
// spawns, because the server verifies the solution itself.
const POW_DIFFICULTY_PREFIX = '0000';
const POW_CHALLENGE_TTL_MS = 30000;
const pendingChallenges = new Map(); // challenge -> expiry timestamp
const usedChallenges = new Set();

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

// A "strike" is a single anti-cheat kick. Only after several strikes from
// the same IP in a short window does that IP actually get banned.
function recordStrikeAndMaybeBan(ip) {
  const now = Date.now();
  const arr = (cheatStrikesByIp.get(ip) || []).filter((t) => now - t <= CHEAT_STRIKE_WINDOW_MS);
  arr.push(now);
  cheatStrikesByIp.set(ip, arr);
  if (arr.length >= CHEAT_STRIKES_BEFORE_BAN) {
    bannedIpsUntil.set(ip, now + CHEAT_BAN_MS);
    return true;
  }
  return false;
}

function kickSocket(socket, room, reason) {
  const ip = getClientIp(socket);
  const banned = recordStrikeAndMaybeBan(ip);
  console.log(
    `[anti-cheat] kicking ${socket.id} (${ip}) from ${room ? room.id : '?'}: ${reason}` +
      (banned ? ` - IP banned ${CHEAT_BAN_MS / 60000}min after repeated strikes` : ' - strike recorded')
  );
  socket.emit('kicked', { reason: 'Removed for suspicious activity.' });
  if (room) room.removePlayer(socket.id);
  socket.disconnect(true);
}

// ---------------------------------------------------------------------------
// Proof-of-work challenge helpers
// ---------------------------------------------------------------------------

function issueChallenge() {
  const challenge = crypto.randomBytes(16).toString('hex');
  pendingChallenges.set(challenge, Date.now() + POW_CHALLENGE_TTL_MS);
  return challenge;
}

function verifyChallenge(challenge, nonce) {
  if (typeof challenge !== 'string' || typeof nonce !== 'string') return false;
  const expiry = pendingChallenges.get(challenge);
  if (!expiry || Date.now() > expiry) return false;
  if (usedChallenges.has(challenge)) return false;

  const hash = crypto.createHash('sha256').update(challenge + nonce).digest('hex');
  if (!hash.startsWith(POW_DIFFICULTY_PREFIX)) return false;

  usedChallenges.add(challenge);
  pendingChallenges.delete(challenge);
  return true;
}

// ---------------------------------------------------------------------------
// Static bush hiding spots (fixed zones, same across restarts)
// ---------------------------------------------------------------------------

function buildBushZones() {
  const zones = [];
  const cols = 6;
  const rows = 6;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Skip some cells for a less uniform layout, and jitter placement.
      if ((r + c) % 3 === 0) continue;
      const cellW = ARENA.width / cols;
      const cellH = ARENA.height / rows;
      zones.push({
        x: cellW * (c + 0.5) + randRange(-cellW * 0.2, cellW * 0.2),
        y: cellH * (r + 0.5) + randRange(-cellH * 0.2, cellH * 0.2),
        radius: randRange(140, 220),
      });
    }
  }
  return zones;
}

const BUSH_ZONES = buildBushZones();

function isInBush(x, y) {
  for (const b of BUSH_ZONES) {
    if (Math.hypot(x - b.x, y - b.y) < b.radius) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Room / game state
// ---------------------------------------------------------------------------

const UPGRADE_TYPES = ['speed', 'shield', 'heart'];
const UPGRADE_TARGET_COUNT = 14;
const UPGRADE_RESPAWN_MS = 12000;
const SPEED_BOOST_DURATION_MS = 8000;
const SHIELD_DURATION_MS = 5000;

class Room {
  constructor(id, index) {
    this.id = id;
    this.name = ROOM_NAMES[index] || `Server ${index + 1}`;
    this.players = new Map();
    this.bones = new Map();
    this.upgrades = new Map();
    this.nextBoneId = 1;
    this.nextUpgradeId = 1;
    for (let i = 0; i < BONE_TARGET_COUNT; i++) this.spawnBone();
    for (let i = 0; i < UPGRADE_TARGET_COUNT; i++) this.spawnUpgrade();
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

  spawnUpgrade() {
    const id = 'u' + this.nextUpgradeId++;
    const type = UPGRADE_TYPES[Math.floor(Math.random() * UPGRADE_TYPES.length)];
    const upgrade = {
      id,
      type,
      x: randRange(200, ARENA.width - 200),
      y: randRange(200, ARENA.height - 200),
    };
    this.upgrades.set(id, upgrade);
    return upgrade;
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
      facing: 0,
      hearts: HEART_MAX,
      bones: 0,
      alive: true,
      lastBiteAt: 0,
      invulnUntil: Date.now() + RESPAWN_INVULN_MS,
      kills: 0,
      speedBoostUntil: 0,
      shieldUntil: 0,
      inBush: false,
      boneTimestamps: [],
      inputTimestamps: [],
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
    player.speedBoostUntil = 0;
    player.shieldUntil = 0;
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

  // Central place where ANY bone gain - ground pickup or stealing - is
  // recorded for the anti-cheat rate check. Earlier versions only tracked
  // ground pickups, which meant bone gains through stealing were invisible
  // to the rate limiter entirely - a real gap, now closed.
  _grantBones(player, amount, kicksOut) {
    player.bones += amount;
    const now = Date.now();
    for (let i = 0; i < amount; i++) player.boneTimestamps.push(now);
    player.boneTimestamps = player.boneTimestamps.filter((t) => now - t <= BONE_CHEAT_WINDOW_MS);
    if (player.boneTimestamps.length > BONE_CHEAT_MAX) {
      kicksOut.push({ id: player.id, reason: 'bone gain rate exceeded' });
    }
  }

  tick(dtSec) {
    this._moveAndDrift(dtSec);
    const kicks = [];
    this._pickUpBones(kicks);
    this._pickUpUpgrades();
    this._updateBushStatus();

    if (this.bones.size < BONE_TARGET_COUNT / 2) this.spawnBone();
    if (this.upgrades.size < UPGRADE_TARGET_COUNT / 2) this.spawnUpgrade();

    const events = this._autoBiteSweep(kicks);
    return { events, kicks };
  }

  _moveAndDrift(dtSec) {
    const decayFactor = Math.max(0, 1 - DRIFT_DECAY_PER_SEC * 60 * dtSec);
    const now = Date.now();
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const mag = Math.hypot(p.dx, p.dy);
      const maxSpeed = now < p.speedBoostUntil ? BASE_MAX_SPEED * SPEED_BOOST_MULTIPLIER : BASE_MAX_SPEED;

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
      if (speed > maxSpeed) {
        p.vx = (p.vx / speed) * maxSpeed;
        p.vy = (p.vy / speed) * maxSpeed;
      }

      let nextX = p.x + p.vx * dtSec;
      let nextY = p.y + p.vy * dtSec;
      if (nextX < PLAYER_RADIUS || nextX > ARENA.width - PLAYER_RADIUS) p.vx = 0;
      if (nextY < PLAYER_RADIUS || nextY > ARENA.height - PLAYER_RADIUS) p.vy = 0;
      p.x = clamp(nextX, PLAYER_RADIUS, ARENA.width - PLAYER_RADIUS);
      p.y = clamp(nextY, PLAYER_RADIUS, ARENA.height - PLAYER_RADIUS);
    }
  }

  _updateBushStatus() {
    for (const p of this.players.values()) {
      p.inBush = p.alive && isInBush(p.x, p.y);
    }
  }

  _pickUpBones(kicks) {
    const kickedThisPass = new Set();
    for (const p of this.players.values()) {
      if (!p.alive || kickedThisPass.has(p.id)) continue;
      let pickedUpThisTick = 0;

      for (const bone of this.bones.values()) {
        const d = Math.hypot(p.x - bone.x, p.y - bone.y);
        if (d < PLAYER_RADIUS + BONE_RADIUS) {
          this.bones.delete(bone.id);
          pickedUpThisTick += 1;
          this._grantBones(p, 1, kicks);

          setTimeout(() => {
            if (this.players.size > 0) this.spawnBone();
          }, BONE_RESPAWN_MS);

          if (pickedUpThisTick > BONE_CHEAT_SINGLE_TICK_MAX) {
            kicks.push({ id: p.id, reason: 'single-tick bone burst' });
            kickedThisPass.add(p.id);
            break;
          }
        }
      }
    }
  }

  _pickUpUpgrades() {
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      for (const up of this.upgrades.values()) {
        const d = Math.hypot(p.x - up.x, p.y - up.y);
        if (d < PLAYER_RADIUS + 18) {
          this.upgrades.delete(up.id);
          this._applyUpgrade(p, up.type);
          setTimeout(() => {
            if (this.players.size > 0) this.spawnUpgrade();
          }, UPGRADE_RESPAWN_MS);
        }
      }
    }
  }

  _applyUpgrade(player, type) {
    const now = Date.now();
    if (type === 'speed') {
      player.speedBoostUntil = now + SPEED_BOOST_DURATION_MS;
    } else if (type === 'shield') {
      player.shieldUntil = now + SHIELD_DURATION_MS;
    } else if (type === 'heart') {
      player.hearts = HEART_MAX;
    }
  }

  _autoBiteSweep(kicks) {
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
        if (now < p.shieldUntil) continue;
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
        this._grantBones(attacker, 1, kicks);
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
    const now = Date.now();
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
        invuln: now < p.invulnUntil,
        shielded: now < p.shieldUntil,
        boosted: now < p.speedBoostUntil,
        inBush: p.inBush,
        kills: p.kills,
      })),
      bones: Array.from(this.bones.values()),
      upgrades: Array.from(this.upgrades.values()),
    };
  }
}

const rooms = new Map();
for (let i = 0; i < 4; i++) {
  const id = `server-${i + 1}`;
  rooms.set(id, new Room(id, i));
}

// ---------------------------------------------------------------------------
// HTTP API
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

app.get('/api/challenge', (req, res) => {
  res.json({ challenge: issueChallenge(), difficultyPrefix: POW_DIFFICULTY_PREFIX });
});

app.get('/', (req, res) => {
  res.send(`SKULP backend is running. (version: ${SERVER_VERSION})`);
});

// ---------------------------------------------------------------------------
// Socket.io
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

    if (!verifyChallenge(payload?.powChallenge, payload?.powNonce)) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Could not verify connection. Please refresh and try again.' });
      }
      console.log(`[anti-cheat] rejected join from ${socket.id} (${ip}): failed proof-of-work check`);
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
      ack({ ok: true, selfId: socket.id, arena: ARENA, roomName: room.name, bushes: BUSH_ZONES });
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

// Housekeeping: drop old rate-limit/ban/challenge history so these maps
// don't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of joinTimestampsByIp.entries()) {
    const fresh = arr.filter((t) => now - t <= JOIN_WINDOW_MS);
    if (fresh.length === 0) joinTimestampsByIp.delete(ip);
    else joinTimestampsByIp.set(ip, fresh);
  }
  for (const [ip, arr] of cheatStrikesByIp.entries()) {
    const fresh = arr.filter((t) => now - t <= CHEAT_STRIKE_WINDOW_MS);
    if (fresh.length === 0) cheatStrikesByIp.delete(ip);
    else cheatStrikesByIp.set(ip, fresh);
  }
  for (const [ip, until] of bannedIpsUntil.entries()) {
    if (now >= until) bannedIpsUntil.delete(ip);
  }
  for (const [challenge, expiry] of pendingChallenges.entries()) {
    if (now > expiry) pendingChallenges.delete(challenge);
  }
}, 60000);

server.listen(PORT, () => {
  console.log(`SKULP server listening on port ${PORT} (version ${SERVER_VERSION})`);
});
