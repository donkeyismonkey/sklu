const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 4000;

// ============================================================
// APP
// ============================================================

const app = express();

app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// ============================================================
// CONFIG
// ============================================================

const ARENA = {
  width: 3000,
  height: 3000,
};

const TICK_HZ = 30;
const TICK_MS = 1000 / TICK_HZ;

const BROADCAST_HZ = 20;
const BROADCAST_MS = 1000 / BROADCAST_HZ;

// REAL PLAYER + BOT LIMIT
const MAX_PLAYERS_PER_ROOM = 40;
const MAX_BOTS_PER_ROOM = 40;

// Gameplay
const PLAYER_RADIUS = 32;
const PLAYER_SPEED = 400;

const BONE_RADIUS = 18;
const BONE_TARGET_COUNT = 60;
const BONE_RESPAWN_MS = 4000;

const BITE_RANGE = 75;
const BITE_COOLDOWN_MS = 500;
const BITE_ARC_DEG = 100;

const HEART_MAX = 3;
const RESPAWN_INVULN_MS = 1800;

const MAX_NAME_LEN = 20;

// Bot thinking
const BOT_THINK_MIN_MS = 250;
const BOT_THINK_MAX_MS = 650;

// Admin key for bot controls.
// Set this in your environment instead of leaving the default.
const BOT_ADMIN_KEY =
  process.env.BOT_ADMIN_KEY || 'change-this-key';

// ============================================================
// ROOM DATA
// ============================================================

const ROOM_NAMES = [
  'Junkyard Prime',
  'Rustbelt Court',
  'The Bonepit',
  'Alley Howl',
];

const HAT_IDS = [
  'none',
  'party',
  'crown',
  'bandana',
  'halo',
  'tinfoil',
];

const BOT_COLORS = [
  '#d97757',
  '#4a90d9',
  '#5fbf6f',
  '#c23b3b',
  '#e8a33d',
  '#8e6bb5',
  '#3a3a3a',
  '#efe6d4',
];

// ============================================================
// HELPERS
// ============================================================

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') {
    return 'Stray Dog';
  }

  const trimmed = raw
    .replace(/[^\w \-'!?]/g, '')
    .trim()
    .slice(0, MAX_NAME_LEN);

  return trimmed.length
    ? trimmed
    : 'Stray Dog';
}

function sanitizeColor(raw) {
  if (
    typeof raw === 'string' &&
    /^#[0-9a-fA-F]{6}$/.test(raw)
  ) {
    return raw;
  }

  return '#d97757';
}

function sanitizeHat(raw) {
  return HAT_IDS.includes(raw)
    ? raw
    : 'none';
}

function randomBotName(room) {
  const used = new Set();

  for (const player of room.players.values()) {
    if (player.isBot) {
      used.add(player.name);
    }
  }

  for (let i = 1; i <= MAX_BOTS_PER_ROOM; i++) {
    const name =
      `Bot_${String(i).padStart(3, '0')}`;

    if (!used.has(name)) {
      return name;
    }
  }

  return `Bot_${Math.floor(Math.random() * 99999)}`;
}

// ============================================================
// ROOM
// ============================================================

class Room {

  constructor(id, index) {

    this.id = id;

    this.name =
      ROOM_NAMES[index] ||
      `Server ${index + 1}`;

    this.players = new Map();

    this.bones = new Map();

    this.nextBoneId = 1;

    for (
      let i = 0;
      i < BONE_TARGET_COUNT;
      i++
    ) {
      this.spawnBone();
    }
  }

  // ----------------------------------------------------------
  // BONE
  // ----------------------------------------------------------

  spawnBone() {

    const id =
      'b' + this.nextBoneId++;

    const bone = {
      id,

      x: randRange(
        PLAYER_RADIUS,
        ARENA.width - PLAYER_RADIUS
      ),

      y: randRange(
        PLAYER_RADIUS,
        ARENA.height - PLAYER_RADIUS
      ),
    };

    this.bones.set(id, bone);

    return bone;
  }

  // ----------------------------------------------------------
  // PLAYER
  // ----------------------------------------------------------

  addPlayer(
    socketId,
    name,
    color,
    hat,
    isBot = false
  ) {

    const player = {

      id: socketId,

      name: sanitizeName(name),

      color: sanitizeColor(color),

      hat: sanitizeHat(hat),

      isBot,

      x: randRange(
        200,
        ARENA.width - 200
      ),

      y: randRange(
        200,
        ARENA.height - 200
      ),

      dx: 0,

      dy: 0,

      facing: 0,

      hearts: HEART_MAX,

      bones: 0,

      alive: true,

      lastBiteAt: 0,

      invulnUntil:
        Date.now() + RESPAWN_INVULN_MS,

      kills: 0,

      // Bot-only data
      botThinkAt: 0,
      botTargetId: null,
    };

    this.players.set(
      socketId,
      player
    );

    return player;
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
  }

  // ----------------------------------------------------------
  // RESPAWN
  // ----------------------------------------------------------

  respawn(player) {

    player.x = randRange(
      200,
      ARENA.width - 200
    );

    player.y = randRange(
      200,
      ARENA.height - 200
    );

    player.dx = 0;
    player.dy = 0;

    player.facing = 0;

    player.hearts = HEART_MAX;

    player.bones = 0;

    player.alive = true;

    player.lastBiteAt = 0;

    player.invulnUntil =
      Date.now() + RESPAWN_INVULN_MS;

    player.botTargetId = null;
  }

  // ----------------------------------------------------------
  // DROP BONES
  // ----------------------------------------------------------

  dropBonesAt(x, y, count) {

    for (
      let i = 0;
      i < count;
      i++
    ) {

      const id =
        'b' + this.nextBoneId++;

      const angle =
        Math.random() * Math.PI * 2;

      const distance =
        randRange(10, 90);

      this.bones.set(id, {

        id,

        x: clamp(
          x + Math.cos(angle) * distance,
          BONE_RADIUS,
          ARENA.width - BONE_RADIUS
        ),

        y: clamp(
          y + Math.sin(angle) * distance,
          BONE_RADIUS,
          ARENA.height - BONE_RADIUS
        ),

      });
    }
  }

  // ==========================================================
  // BOT AI
  // ==========================================================

  updateBots(now) {

    for (const bot of this.players.values()) {

      if (!bot.isBot)
        continue;

      if (!bot.alive)
        continue;

      // Keep existing movement between thoughts.
      if (now < bot.botThinkAt)
        continue;

      bot.botThinkAt =
        now +
        randRange(
          BOT_THINK_MIN_MS,
          BOT_THINK_MAX_MS
        );

      let target = null;
      let closestDistance = Infinity;

      // ------------------------------------------------------
      // Find nearest bone
      // ------------------------------------------------------

      for (const bone of this.bones.values()) {

        const distance =
          Math.hypot(
            bot.x - bone.x,
            bot.y - bone.y
          );

        if (
          distance < closestDistance
        ) {

          closestDistance = distance;

          target = bone;
        }
      }

      // ------------------------------------------------------
      // Sometimes hunt a human player
      // ------------------------------------------------------

      if (Math.random() < 0.40) {

        let closestPlayer = null;
        let closestPlayerDistance =
          Infinity;

        for (
          const player
          of this.players.values()
        ) {

          if (
            player.id === bot.id ||
            player.isBot ||
            !player.alive
          ) {
            continue;
          }

          const distance =
            Math.hypot(
              bot.x - player.x,
              bot.y - player.y
            );

          if (
            distance <
            closestPlayerDistance
          ) {

            closestPlayerDistance =
              distance;

            closestPlayer =
              player;
          }
        }

        if (closestPlayer) {

          target =
            closestPlayer;

          closestDistance =
            closestPlayerDistance;

          bot.botTargetId =
            closestPlayer.id;
        }
      }

      // ------------------------------------------------------
      // No target
      // ------------------------------------------------------

      if (!target) {

        bot.dx =
          Math.random() * 2 - 1;

        bot.dy =
          Math.random() * 2 - 1;

        bot.botTargetId = null;

        continue;
      }

      // ------------------------------------------------------
      // Move toward target
      // ------------------------------------------------------

      const dx =
        target.x - bot.x;

      const dy =
        target.y - bot.y;

      const distance =
        Math.hypot(dx, dy);

      if (distance > 0.001) {

        bot.dx =
          dx / distance;

        bot.dy =
          dy / distance;

        bot.facing =
          Math.atan2(
            bot.dy,
            bot.dx
          );
      }

      // ------------------------------------------------------
      // Bite humans
      // ------------------------------------------------------

      if (
        !target.isBot &&
        distance <= BITE_RANGE
      ) {

        const result =
          this.handleBite(bot.id);

        if (
          result &&
          result.event
        ) {

          io.to(this.id).emit(
            'event',
            {
              type: result.event,

              attacker:
                result.attacker.name,

              target:
                result.target.name,
            }
          );
        }
      }
    }
  }

  // ==========================================================
  // GAME TICK
  // ==========================================================

  tick(dtSec) {

    const now =
      Date.now();

    // Bots decide what they want to do.
    this.updateBots(now);

    // --------------------------------------------------------
    // MOVEMENT
    // --------------------------------------------------------

    for (
      const player
      of this.players.values()
    ) {

      if (!player.alive)
        continue;

      const magnitude =
        Math.hypot(
          player.dx,
          player.dy
        );

      if (magnitude > 0.001) {

        const nx =
          player.dx / magnitude;

        const ny =
          player.dy / magnitude;

        player.x =
          clamp(
            player.x +
              nx *
              PLAYER_SPEED *
              dtSec,

            PLAYER_RADIUS,

            ARENA.width -
              PLAYER_RADIUS
          );

        player.y =
          clamp(
            player.y +
              ny *
              PLAYER_SPEED *
              dtSec,

            PLAYER_RADIUS,

            ARENA.height -
              PLAYER_RADIUS
          );

        // Humans can control facing through input.
        // Bots have their facing set by AI.
        if (!player.isBot) {

          player.facing =
            Math.atan2(
              ny,
              nx
            );
        }
      }
    }

    // --------------------------------------------------------
    // BONE PICKUP
    // --------------------------------------------------------

    for (
      const player
      of this.players.values()
    ) {

      if (!player.alive)
        continue;

      for (
        const bone
        of this.bones.values()
      ) {

        const distance =
          Math.hypot(
            player.x - bone.x,
            player.y - bone.y
          );

        if (
          distance <
          PLAYER_RADIUS +
          BONE_RADIUS
        ) {

          // IMPORTANT:
          // Delete the actual bone ID.
          this.bones.delete(
            bone.id
          );

          player.bones += 1;

          setTimeout(() => {

            if (
              this.bones.size <
              BONE_TARGET_COUNT
            ) {
              this.spawnBone();
            }

          }, BONE_RESPAWN_MS);
        }
      }
    }

    // Maintain bone population.
    while (
      this.bones.size <
      BONE_TARGET_COUNT
    ) {

      this.spawnBone();
    }
  }

  // ==========================================================
  // BITE
  // ==========================================================

  handleBite(attackerId) {

    const now =
      Date.now();

    const attacker =
      this.players.get(
        attackerId
      );

    if (
      !attacker ||
      !attacker.alive
    ) {
      return null;
    }

    // Cooldown
    if (
      now -
      attacker.lastBiteAt <
      BITE_COOLDOWN_MS
    ) {
      return null;
    }

    attacker.lastBiteAt =
      now;

    let target = null;

    let bestDistance =
      Infinity;

    for (
      const player
      of this.players.values()
    ) {

      if (
        player.id ===
        attacker.id
      ) {
        continue;
      }

      if (!player.alive)
        continue;

      if (
        now <
        player.invulnUntil
      ) {
        continue;
      }

      const dx =
        player.x -
        attacker.x;

      const dy =
        player.y -
        attacker.y;

      const distance =
        Math.hypot(dx, dy);

      if (
        distance >
        BITE_RANGE
      ) {
        continue;
      }

      const targetAngle =
        Math.atan2(dy, dx);

      let angleDifference =
        Math.abs(
          targetAngle -
          attacker.facing
        );

      if (
        angleDifference >
        Math.PI
      ) {

        angleDifference =
          Math.PI * 2 -
          angleDifference;
      }

      const biteArc =
        (BITE_ARC_DEG *
          Math.PI /
          180) /
        2;

      if (
        angleDifference >
        biteArc
      ) {
        continue;
      }

      if (
        distance <
        bestDistance
      ) {

        bestDistance =
          distance;

        target =
          player;
      }
    }

    if (!target) {

      return {
        attacker,
        target: null,
      };
    }

    // --------------------------------------------------------
    // STEAL BONE
    // --------------------------------------------------------

    if (target.bones > 0) {

      target.bones -= 1;

      attacker.bones += 1;

      return {
        attacker,
        target,
        event: 'steal',
      };
    }

    // --------------------------------------------------------
    // DAMAGE
    // --------------------------------------------------------

    target.hearts -= 1;

    // --------------------------------------------------------
    // KILL
    // --------------------------------------------------------

    if (
      target.hearts <= 0
    ) {

      const droppedBones =
        target.bones;

      target.alive = false;

      target.bones = 0;

      this.dropBonesAt(
        target.x,
        target.y,
        droppedBones
      );

      attacker.kills += 1;

      setTimeout(() => {

        if (
          this.players.has(
            target.id
          )
        ) {

          this.respawn(
            target
          );
        }

      }, 1600);

      return {
        attacker,
        target,
        event: 'kill',
      };
    }

    return {
      attacker,
      target,
      event: 'hit',
    };
  }

  // ==========================================================
  // SNAPSHOT
  // ==========================================================

  snapshot() {

    return {

      arena: ARENA,

      players:
        Array.from(
          this.players.values()
        ).map(player => ({

          id: player.id,

          name: player.name,

          color: player.color,

          hat: player.hat,

          x: Math.round(
            player.x
          ),

          y: Math.round(
            player.y
          ),

          facing:
            Math.round(
              player.facing *
              100
            ) / 100,

          hearts:
            player.hearts,

          bones:
            player.bones,

          alive:
            player.alive,

          invuln:
            Date.now() <
            player.invulnUntil,

          kills:
            player.kills,

          // Client can identify bots.
          isBot:
            !!player.isBot,

        })),

      bones:
        Array.from(
          this.bones.values()
        ),

    };
  }

  // ==========================================================
  // BOT INFO
  // ==========================================================

  getBots() {

    return Array.from(
      this.players.values()
    )
      .filter(
        player => player.isBot
      )
      .map(player => ({

        id: player.id,

        name: player.name,

        color: player.color,

        hat: player.hat,

      }));
  }
}

// ============================================================
// CREATE ROOMS
// ============================================================

const rooms = new Map();

for (
  let i = 0;
  i < 4;
  i++
) {

  const id =
    `server-${i + 1}`;

  rooms.set(
    id,
    new Room(id, i)
  );
}

// ============================================================
// ADMIN AUTH
// ============================================================

function validBotAdmin(req) {

  const suppliedKey =
    req.get(
      'x-bot-admin-key'
    );

  if (
    typeof suppliedKey !==
    'string'
  ) {
    return false;
  }

  return suppliedKey ===
    BOT_ADMIN_KEY;
}

// ============================================================
// BOT RESPONSE
// ============================================================

function botResponse(room) {

  const bots =
    room.getBots();

  return {

    ok: true,

    room: room.id,

    roomName: room.name,

    roomPlayers:
      room.players.size,

    maxPlayers:
      MAX_PLAYERS_PER_ROOM,

    botCount:
      bots.length,

    bots,

  };
}

// ============================================================
// SERVER LIST
// ============================================================

app.get(
  '/api/servers',
  (req, res) => {

    const list =
      Array.from(
        rooms.values()
      ).map(room => ({

        id:
          room.id,

        name:
          room.name,

        players:
          room.players.size,

        maxPlayers:
          MAX_PLAYERS_PER_ROOM,

        bots:
          Array.from(
            room.players.values()
          ).filter(
            player =>
              player.isBot
          ).length,

      }));

    res.json({
      servers: list,
    });
  }
);

// ============================================================
// PING
// ============================================================

app.get(
  '/api/ping',
  (req, res) => {

    res.json({
      t: Date.now(),
    });

  }
);

// ============================================================
// BOT LIST
// ============================================================

app.get(
  '/api/bots',
  (req, res) => {

    if (!validBotAdmin(req)) {

      return res
        .status(403)
        .json({

          ok: false,

          error:
            'Invalid bot admin key.',

        });
    }

    const room =
      rooms.get(
        req.query.room
      );

    if (!room) {

      return res
        .status(404)
        .json({

          ok: false,

          error:
            'Server not found.',

        });
    }

    res.json(
      botResponse(room)
    );
  }
);

// ============================================================
// ADD BOTS
// ============================================================

app.post(
  '/api/bots/add',
  (req, res) => {

    if (!validBotAdmin(req)) {

      return res
        .status(403)
        .json({

          ok: false,

          error:
            'Invalid bot admin key.',

        });
    }

    const room =
      rooms.get(
        req.body?.room
      );

    if (!room) {

      return res
        .status(404)
        .json({

          ok: false,

          error:
            'Server not found.',

        });
    }

    let requested =
      Number(
        req.body?.count
      );

    if (
      !Number.isFinite(
        requested
      )
    ) {
      requested = 1;
    }

    requested =
      Math.floor(
        requested
      );

    requested =
      clamp(
        requested,
        1,
        MAX_BOTS_PER_ROOM
      );

    const currentBots =
      room.getBots().length;

    const availableSlots =
      MAX_PLAYERS_PER_ROOM -
      room.players.size;

    const botSlots =
      MAX_BOTS_PER_ROOM -
      currentBots;

    const amountToAdd =
      Math.min(
        requested,
        availableSlots,
        botSlots
      );

    let added = 0;

    for (
      let i = 0;
      i < amountToAdd;
      i++
    ) {

      const botNumber =
        currentBots +
        i +
        1;

      const botName =
        randomBotName(room);

      const color =
        BOT_COLORS[
          botNumber %
          BOT_COLORS.length
        ];

      const hat =
        HAT_IDS[
          botNumber %
          HAT_IDS.length
        ];

      const botId =
        `bot-${room.id}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;

      room.addPlayer(
        botId,
        botName,
        color,
        hat,
        true
      );

      added++;
    }

    // Immediately update connected players.
    io.to(room.id).emit(
      'state',
      room.snapshot()
    );

    io.to(room.id).emit(
      'lobby-update',
      {
        room:
          room.id,

        players:
          room.players.size,

        maxPlayers:
          MAX_PLAYERS_PER_ROOM,

        bots:
          room.getBots().length,
      }
    );

    res.json({

      ...botResponse(room),

      added,

    });
  }
);

// ============================================================
// REMOVE BOTS
// ============================================================

app.post(
  '/api/bots/remove',
  (req, res) => {

    if (!validBotAdmin(req)) {

      return res
        .status(403)
        .json({

          ok: false,

          error:
            'Invalid bot admin key.',

        });
    }

    const room =
      rooms.get(
        req.body?.room
      );

    if (!room) {

      return res
        .status(404)
        .json({

          ok: false,

          error:
            'Server not found.',

        });
    }

    let requested =
      Number(
        req.body?.count
      );

    if (
      !Number.isFinite(
        requested
      )
    ) {
      requested = 1;
    }

    requested =
      clamp(
        Math.floor(requested),
        1,
        MAX_BOTS_PER_ROOM
      );

    let removed = 0;

    for (
      const [id, player]
      of room.players
    ) {

      if (
        removed >=
        requested
      ) {
        break;
      }

      if (!player.isBot)
        continue;

      room.removePlayer(id);

      removed++;
    }

    io.to(room.id).emit(
      'state',
      room.snapshot()
    );

    io.to(room.id).emit(
      'lobby-update',
      {
        room:
          room.id,

        players:
          room.players.size,

        maxPlayers:
          MAX_PLAYERS_PER_ROOM,

        bots:
          room.getBots().length,
      }
    );

    res.json({

      ...botResponse(room),

      removed,

    });
  }
);

// ============================================================
// REMOVE ALL BOTS
// ============================================================

app.post(
  '/api/bots/remove-all',
  (req, res) => {

    if (!validBotAdmin(req)) {

      return res
        .status(403)
        .json({

          ok: false,

          error:
            'Invalid bot admin key.',

        });
    }

    const room =
      rooms.get(
        req.body?.room
      );

    if (!room) {

      return res
        .status(404)
        .json({

          ok: false,

          error:
            'Server not found.',

        });
    }

    let removed = 0;

    for (
      const [id, player]
      of room.players
    ) {

      if (!player.isBot)
        continue;

      room.removePlayer(id);

      removed++;
    }

    io.to(room.id).emit(
      'state',
      room.snapshot()
    );

    io.to(room.id).emit(
      'lobby-update',
      {
        room:
          room.id,

        players:
          room.players.size,

        maxPlayers:
          MAX_PLAYERS_PER_ROOM,

        bots:
          room.getBots().length,
      }
    );

    res.json({

      ...botResponse(room),

      removed,

    });
  }
);

// ============================================================
// ROOT
// ============================================================

app.get(
  '/',
  (req, res) => {

    res.send(
      'SKULP backend is running.'
    );

  }
);

// ============================================================
// SOCKET.IO
// ============================================================

io.on(
  'connection',
  (socket) => {

    let currentRoomId = null;

    // --------------------------------------------------------
    // JOIN
    // --------------------------------------------------------

    socket.on(
      'join',
      (payload, ack) => {

        const roomId =
          typeof payload?.room ===
          'string'
            ? payload.room
            : null;

        const room =
          rooms.get(roomId);

        if (!room) {

          if (
            typeof ack ===
            'function'
          ) {

            ack({

              ok: false,

              error:
                'Server not found.',

            });
          }

          return;
        }

        if (
          room.players.size >=
          MAX_PLAYERS_PER_ROOM
        ) {

          if (
            typeof ack ===
            'function'
          ) {

            ack({

              ok: false,

              error:
                'That server is full.',

            });
          }

          return;
        }

        // If already in another room,
        // remove old player.
        if (currentRoomId) {

          const oldRoom =
            rooms.get(
              currentRoomId
            );

          if (oldRoom) {

            oldRoom.removePlayer(
              socket.id
            );

            socket.leave(
              currentRoomId
            );
          }
        }

        const name =
          sanitizeName(
            payload?.name
          );

        const color =
          sanitizeColor(
            payload?.color
          );

        const hat =
          sanitizeHat(
            payload?.hat
          );

        const player =
          room.addPlayer(
            socket.id,
            name,
            color,
            hat,
            false
          );

        socket.join(
          roomId
        );

        currentRoomId =
          roomId;

        if (
          typeof ack ===
          'function'
        ) {

          ack({

            ok: true,

            selfId:
              socket.id,

            arena:
              ARENA,

            roomName:
              room.name,

          });
        }

        socket.emit(
          'state',
          room.snapshot()
        );

        io.to(room.id).emit(
          'lobby-update',
          {
            room:
              room.id,

            players:
              room.players.size,

            maxPlayers:
              MAX_PLAYERS_PER_ROOM,

            bots:
              room.getBots().length,
          }
        );
      }
    );

    // --------------------------------------------------------
    // INPUT
    // --------------------------------------------------------

    socket.on(
      'input',
      (payload) => {

        if (!currentRoomId)
          return;

        const room =
          rooms.get(
            currentRoomId
          );

        if (!room)
          return;

        const player =
          room.players.get(
            socket.id
          );

        if (!player)
          return;

        // Bots never accept client input.
        if (player.isBot)
          return;

        const dx =
          clamp(
            Number(
              payload?.dx
            ) || 0,

            -1,
            1
          );

        const dy =
          clamp(
            Number(
              payload?.dy
            ) || 0,

            -1,
            1
          );

        player.dx = dx;
        player.dy = dy;

        if (
          typeof payload?.facing ===
          'number' &&
          Number.isFinite(
            payload.facing
          )
        ) {

          player.facing =
            payload.facing;
        }
      }
    );

    // --------------------------------------------------------
    // BITE
    // --------------------------------------------------------

    socket.on(
      'bite',
      () => {

        if (!currentRoomId)
          return;

        const room =
          rooms.get(
            currentRoomId
          );

        if (!room)
          return;

        const player =
          room.players.get(
            socket.id
          );

        if (!player)
          return;

        // Bots don't send socket bites.
        if (player.isBot)
          return;

        const result =
          room.handleBite(
            socket.id
          );

        if (
          result?.event &&
          result?.target
        ) {

          io.to(
            currentRoomId
          ).emit(
            'event',
            {

              type:
                result.event,

              attacker:
                result.attacker.name,

              target:
                result.target.name,

            }
          );
        }
      }
    );

    // --------------------------------------------------------
    // PING PROBE
    // --------------------------------------------------------

    socket.on(
      'ping-probe',
      (_payload, ack) => {

        if (
          typeof ack ===
          'function'
        ) {

          ack(
            Date.now()
          );
        }
      }
    );

    // --------------------------------------------------------
    // DISCONNECT
    // --------------------------------------------------------

    socket.on(
      'disconnect',
      () => {

        if (!currentRoomId)
          return;

        const room =
          rooms.get(
            currentRoomId
          );

        if (room) {

          room.removePlayer(
            socket.id
          );

          io.to(room.id).emit(
            'lobby-update',
            {
              room:
                room.id,

              players:
                room.players.size,

              maxPlayers:
                MAX_PLAYERS_PER_ROOM,

              bots:
                room.getBots().length,
            }
          );
        }

        currentRoomId =
          null;
      }
    );
  }
);

// ============================================================
// GAME LOOP
// ============================================================

let lastTick =
  Date.now();

setInterval(
  () => {

    const now =
      Date.now();

    let dtSec =
      (now - lastTick) /
      1000;

    lastTick =
      now;

    // Prevent giant physics jumps
    // if the server freezes briefly.
    dtSec =
      clamp(
        dtSec,
        0,
        0.1
      );

    for (
      const room
      of rooms.values()
    ) {

      if (
        room.players.size ===
        0
      ) {
        continue;
      }

      room.tick(
        dtSec
      );
    }

  },
  TICK_MS
);

// ============================================================
// STATE BROADCAST
// ============================================================

setInterval(
  () => {

    for (
      const room
      of rooms.values()
    ) {

      if (
        room.players.size ===
        0
      ) {
        continue;
      }

      io.to(room.id).emit(
        'state',
        room.snapshot()
      );
    }

  },
  BROADCAST_MS
);

// ============================================================
// START
// ============================================================

server.listen(
  PORT,
  () => {

    console.log(
      '======================================'
    );

    console.log(
      '          SKULP SERVER'
    );

    console.log(
      '======================================'
    );

    console.log(
      `Server running on port ${PORT}`
    );

    console.log(
      `Max players per room: ${MAX_PLAYERS_PER_ROOM}`
    );

    console.log(
      `Max bots per room: ${MAX_BOTS_PER_ROOM}`
    );

    console.log(
      'Bot API: ENABLED'
    );

    console.log(
      '======================================'
    );

  }
);
