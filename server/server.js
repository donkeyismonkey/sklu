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
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const ARENA = {
  width: 3000,
  height: 3000
};

const TICK_HZ = 30;
const TICK_MS = 1000 / TICK_HZ;

const BROADCAST_HZ = 20;
const BROADCAST_MS = 1000 / BROADCAST_HZ;

const MAX_PLAYERS_PER_ROOM = 40;

const PLAYER_RADIUS = 22;
const PLAYER_SPEED = 260;

const BONE_RADIUS = 14;
const BONE_TARGET_COUNT = 60;
const BONE_RESPAWN_MS = 4000;

const BITE_RANGE = 62;
const BITE_COOLDOWN_MS = 550;
const BITE_ARC_DEG = 100;

const HEART_MAX = 3;
const RESPAWN_INVULN_MS = 1800;

const MAX_NAME_LEN = 14;

const ROOM_NAMES = [
  'Junkyard Prime',
  'Rustbelt Court',
  'The Bonepit',
  'Alley Howl'
];

const HAT_IDS = [
  'none',
  'party',
  'crown',
  'bandana',
  'halo',
  'tinfoil'
];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function randRange(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') {
    return 'Stray Dog';
  }

  const trimmed = raw
    .replace(/[^\w \-'!?]/g, '')
    .trim()
    .slice(0, MAX_NAME_LEN);

  return trimmed.length ? trimmed : 'Stray Dog';
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
  return HAT_IDS.includes(raw) ? raw : 'none';
}

function rgbToHex(r, g, b) {

  r = clamp(Number(r) || 0, 0, 255);
  g = clamp(Number(g) || 0, 0, 255);
  b = clamp(Number(b) || 0, 0, 255);

  return '#' + [r, g, b]
    .map(v =>
      Math.round(v)
        .toString(16)
        .padStart(2, '0')
    )
    .join('');
}

function findPlayer(room, identifier) {

  if (!room || identifier == null) {
    return null;
  }

  const value = String(identifier);

  if (room.players.has(value)) {
    return room.players.get(value);
  }

  for (const player of room.players.values()) {

    if (
      player.name.toLowerCase() ===
      value.toLowerCase()
    ) {
      return player;
    }

  }

  return null;
}

function broadcastRoom(room) {

  if (!room) return;

  io.to(room.id).emit(
    'state',
    room.snapshot()
  );

  io.to(room.id).emit(
    'lobby-update',
    {
      room: room.id,
      players: room.players.size,
      maxPlayers: MAX_PLAYERS_PER_ROOM
    }
  );
}

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

  spawnBone() {

    const id =
      'b' + this.nextBoneId++;

    const bone = {
      id,

      x: randRange(
        BONE_RADIUS * 2,
        ARENA.width - BONE_RADIUS * 2
      ),

      y: randRange(
        BONE_RADIUS * 2,
        ARENA.height - BONE_RADIUS * 2
      )
    };

    this.bones.set(id, bone);

    return bone;
  }

  addPlayer(
    socketId,
    name,
    color,
    hat,
    isBot = false
  ) {

    const player = {

      id: socketId,

      name,

      color,

      hat,

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
        Date.now() +
        RESPAWN_INVULN_MS,

      kills: 0,

      speed: PLAYER_SPEED,

      rgb: {
        r: 217,
        g: 119,
        b: 87
      },

      isBot
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

  respawn(player) {

    player.x = randRange(
      200,
      ARENA.width - 200
    );

    player.y = randRange(
      200,
      ARENA.height - 200
    );

    player.hearts = HEART_MAX;

    player.bones = 0;

    player.alive = true;

    player.invulnUntil =
      Date.now() +
      RESPAWN_INVULN_MS;
  }

  dropBonesAt(x, y, count) {

    count = Math.max(
      0,
      Math.min(
        Math.floor(
          Number(count) || 0
        ),
        100
      )
    );

    for (
      let i = 0;
      i < count;
      i++
    ) {

      const id =
        'b' + this.nextBoneId++;

      const angle =
        Math.random() *
        Math.PI *
        2;

      const dist =
        randRange(10, 90);

      this.bones.set(
        id,
        {
          id,

          x: clamp(
            x +
            Math.cos(angle) *
            dist,

            BONE_RADIUS,

            ARENA.width -
            BONE_RADIUS
          ),

          y: clamp(
            y +
            Math.sin(angle) *
            dist,

            BONE_RADIUS,

            ARENA.height -
            BONE_RADIUS
          )
        }
      );
    }
  }

  tick(dtSec) {

    const now = Date.now();

    for (
      const p of this.players.values()
    ) {

      if (!p.alive) continue;

      const mag =
        Math.hypot(
          p.dx,
          p.dy
        );

      if (mag > 0.001) {

        const nx =
          p.dx / mag;

        const ny =
          p.dy / mag;

        p.x = clamp(
          p.x +
          nx *
          p.speed *
          dtSec,

          PLAYER_RADIUS,

          ARENA.width -
          PLAYER_RADIUS
        );

        p.y = clamp(
          p.y +
          ny *
          p.speed *
          dtSec,

          PLAYER_RADIUS,

          ARENA.height -
          PLAYER_RADIUS
        );

        p.facing =
          Math.atan2(
            ny,
            nx
          );
      }
    }

    for (
      const p of this.players.values()
    ) {

      if (!p.alive) continue;

      for (
        const bone of this.bones.values()
      ) {

        const d =
          Math.hypot(
            p.x - bone.x,
            p.y - bone.y
          );

        if (
          d <
          PLAYER_RADIUS +
          BONE_RADIUS
        ) {

          this.bones.delete(
            bone.id
          );

          p.bones += 1;

          setTimeout(
            () => {

              if (
                this.players.size > 0
              ) {
                this.spawnBone();
              }

            },
            BONE_RESPAWN_MS
          );
        }
      }
    }

    if (
      this.bones.size <
      BONE_TARGET_COUNT / 2
    ) {
      this.spawnBone();
    }

    for (
      const bot of this.players.values()
    ) {

      if (
        !bot.isBot ||
        !bot.alive
      ) {
        continue;
      }

      if (
        Math.random() < 0.04
      ) {

        const angle =
          Math.random() *
          Math.PI *
          2;

        bot.dx =
          Math.cos(angle);

        bot.dy =
          Math.sin(angle);

        bot.facing =
          angle;
      }

      if (
        Math.random() < 0.02
      ) {
        this.handleBite(
          bot.id
        );
      }
    }
  }

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

    let bestDist =
      Infinity;

    for (
      const p of this.players.values()
    ) {

      if (
        p.id === attacker.id ||
        !p.alive
      ) {
        continue;
      }

      if (
        now <
        p.invulnUntil
      ) {
        continue;
      }

      const dx =
        p.x -
        attacker.x;

      const dy =
        p.y -
        attacker.y;

      const dist =
        Math.hypot(
          dx,
          dy
        );

      if (
        dist >
        BITE_RANGE
      ) {
        continue;
      }

      const angleToTarget =
        Math.atan2(
          dy,
          dx
        );

      let diff =
        Math.abs(
          angleToTarget -
          attacker.facing
        );

      if (
        diff >
        Math.PI
      ) {
        diff =
          Math.PI * 2 -
          diff;
      }

      if (
        diff >
        (
          BITE_ARC_DEG *
          Math.PI
        ) /
        180 /
        2
      ) {
        continue;
      }

      if (
        dist <
        bestDist
      ) {

        bestDist =
          dist;

        target =
          p;
      }
    }

    if (!target) {

      return {
        attacker,
        target: null
      };
    }

    if (
      target.bones > 0
    ) {

      target.bones -= 1;

      attacker.bones += 1;

      return {
        attacker,
        target,
        event: 'steal'
      };
    }

    target.hearts -= 1;

    if (
      target.hearts <= 0
    ) {

      const droppedBones =
        target.bones;

      target.alive =
        false;

      target.bones =
        0;

      this.dropBonesAt(
        target.x,
        target.y,
        droppedBones
      );

      attacker.kills += 1;

      setTimeout(
        () => {

          if (
            this.players.has(
              target.id
            )
          ) {

            this.respawn(
              target
            );

            broadcastRoom(
              this
            );
          }

        },
        1600
      );

      return {
        attacker,
        target,
        event: 'kill'
      };
    }

    return {
      attacker,
      target,
      event: 'hit'
    };
  }

  snapshot() {

    return {

      arena: ARENA,

      players:
        Array.from(
          this.players.values()
        ).map(
          p => ({

            id: p.id,

            name: p.name,

            color: p.color,

            hat: p.hat,

            x: Math.round(
              p.x
            ),

            y: Math.round(
              p.y
            ),

            facing:
              Math.round(
                p.facing * 100
              ) / 100,

            hearts:
              p.hearts,

            bones:
              p.bones,

            alive:
              p.alive,

            invuln:
              Date.now() <
              p.invulnUntil,

            kills:
              p.kills,

            speed:
              p.speed,

            rgb:
              p.rgb,

            isBot:
              p.isBot
          })
        ),

      bones:
        Array.from(
          this.bones.values()
        )
    };
  }
}

const rooms =
  new Map();

for (
  let i = 0;
  i < 4;
  i++
) {

  const id =
   `server-${i + 1}`;

  rooms.set(
    id,
    new Room(
      id,
      i
    )
  );
}

app.get(
  '/api/servers',
  (req, res) => {

    const servers =
      Array.from(
        rooms.values()
      ).map(
        room => ({

          id: room.id,

          name: room.name,

          players:
            room.players.size,

          maxPlayers:
            MAX_PLAYERS_PER_ROOM
        })
      );

    res.json({
      servers
    });
  }
);

app.get(
  '/api/players',
  (req, res) => {

    const roomId =
      typeof req.query.room ===
      'string'
        ? req.query.room
        : null;

    const room =
      rooms.get(roomId);

    if (!room) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Server not found.'
        });
    }

    res.json({

      ok: true,

      room: room.id,

      players:
        Array.from(
          room.players.values()
        ).map(
          p => ({

            id: p.id,

            name: p.name,

            bones: p.bones,

            hearts: p.hearts,

            speed: p.speed,

            color: p.color,

            rgb: p.rgb,

            kills: p.kills,

            alive: p.alive,

            isBot: p.isBot
          })
        )
    });
  }
);

app.get(
  '/api/ping',
  (req, res) => {

    res.json({
      ok: true,
      t: Date.now()
    });
  }
);

app.get(
  '/',
  (req, res) => {

    res.send(
      'SKULP backend is running.'
    );
  }
);

app.post(
  '/api/owner/give-bones',
  (req, res) => {

    const {
      room: roomId,
      player: identifier,
      amount
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Server not found.'
        });
    }

    const player =
      findPlayer(
        room,
        identifier
      );

    if (!player) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Player not found.'
        });
    }

    const add =
      clamp(
        Math.floor(
          Number(amount) || 0
        ),
        -100000,
        100000
      );

    player.bones =
      Math.max(
        0,
        player.bones + add
      );

    broadcastRoom(room);

    res.json({
      ok: true,
      player: player.name,
      bones: player.bones
    });
  }
);

app.post(
  '/api/owner/set-speed',
  (req, res) => {

    const {
      room: roomId,
      player: identifier,
      speed
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Server not found.'
        });
    }

    const player =
      findPlayer(
        room,
        identifier
      );

    if (!player) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Player not found.'
        });
    }

    player.speed =
      clamp(
        Number(speed) ||
        PLAYER_SPEED,
        0,
        5000
      );

    broadcastRoom(room);

    res.json({
      ok: true,
      player: player.name,
      speed: player.speed
    });
  }
);

app.post(
  '/api/owner/reset-speed',
  (req, res) => {

    const {
      room: roomId,
      player: identifier
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Server not found.'
        });
    }

    const player =
      findPlayer(
        room,
        identifier
      );

    if (!player) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Player not found.'
        });
    }

    player.speed =
      PLAYER_SPEED;

    broadcastRoom(room);

    res.json({
      ok: true,
      player: player.name,
      speed: player.speed
    });
  }
);

app.post(
  '/api/owner/set-color',
  (req, res) => {

    const {
      room: roomId,
      player: identifier,
      r,
      g,
      b
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Server not found.'
        });
    }

    const player =
      findPlayer(
        room,
        identifier
      );

    if (!player) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Player not found.'
        });
    }

    player.rgb = {

      r: clamp(
        Math.round(
          Number(r) || 0
        ),
        0,
        255
      ),

      g: clamp(
        Math.round(
          Number(g) || 0
        ),
        0,
        255
      ),

      b: clamp(
        Math.round(
          Number(b) || 0
        ),
        0,
        255
      )
    };

    player.color =
      rgbToHex(
        player.rgb.r,
        player.rgb.g,
        player.rgb.b
      );

    broadcastRoom(room);

    res.json({
      ok: true,
      player: player.name,
      color: player.color,
      rgb: player.rgb
    });
  }
);

app.post(
  '/api/owner/reset-color',
  (req, res) => {

    const {
      room: roomId,
      player: identifier
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Server not found.'
        });
    }

    const player =
      findPlayer(
        room,
        identifier
      );

    if (!player) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Player not found.'
        });
    }

    player.rgb = {
      r: 217,
      g: 119,
      b: 87
    };

    player.color =
      '#d97757';

    broadcastRoom(room);

    res.json({
      ok: true,
      player: player.name,
      color: player.color,
      rgb: player.rgb
    });
  }
);

app.post(
  '/api/owner/set-all-speed',
  (req, res) => {

    const {
      room: roomId,
      speed
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Server not found.'
        });
    }

    const value =
      clamp(
        Number(speed) ||
        PLAYER_SPEED,
        0,
        5000
      );

    for (
      const player of room.players.values()
    ) {
      player.speed =
        value;
    }

    broadcastRoom(room);

    res.json({
      ok: true,
      speed: value,
      players:
        room.players.size
    });
  }
);

app.post(
  '/api/owner/reset-all-speed',
  (req, res) => {

    const {
      room: roomId
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Server not found.'
        });
    }

    for (
      const player of room.players.values()
    ) {
      player.speed =
        PLAYER_SPEED;
    }

    broadcastRoom(room);

    res.json({
      ok: true,
      speed:
        PLAYER_SPEED
    });
  }
);

app.post(
  '/api/owner/set-all-color',
  (req, res) => {

    const {
      room: roomId,
      r,
      g,
      b
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Server not found.'
        });
    }

    const rgb = {

      r: clamp(
        Math.round(
          Number(r) || 0
        ),
        0,
        255
      ),

      g: clamp(
        Math.round(
          Number(g) || 0
        ),
        0,
        255
      ),

      b: clamp(
        Math.round(
          Number(b) || 0
        ),
        0,
        255
      )
    };

    const color =
      rgbToHex(
        rgb.r,
        rgb.g,
        rgb.b
      );

    for (
      const player of room.players.values()
    ) {

      player.rgb = {
        ...rgb
      };

      player.color =
        color;
    }

    broadcastRoom(room);

    res.json({
      ok: true,
      color,
      rgb
    });
  }
);

app.post(
  '/api/owner/reset-all-color',
  (req, res) => {

    const {
      room: roomId
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Server not found.'
        });
    }

    for (
      const player of room.players.values()
    ) {

      player.rgb = {
        r: 217,
        g: 119,
        b: 87
      };

      player.color =
        '#d97757';
    }

    broadcastRoom(room);

    res.json({
      ok: true,
      color:
        '#d97757'
    });
  }
);

app.post(
  '/api/owner/set-hearts',
  (req, res) => {

    const {
      room: roomId,
      player: identifier,
      hearts
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Server not found.'
        });
    }

    const player =
      findPlayer(
        room,
        identifier
      );

    if (!player) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Player not found.'
        });
    }

    player.hearts =
      clamp(
        Math.floor(
          Number(hearts) || 0
        ),
        0,
        100
      );

    if (
      player.hearts > 0
    ) {
      player.alive =
        true;
    }

    broadcastRoom(room);

    res.json({
      ok: true,
      player: player.name,
      hearts:
        player.hearts
    });
  }
);

app.post(
  '/api/owner/kill',
  (req, res) => {

    const {
      room: roomId,
      player: identifier
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Server not found.'
        });
    }

    const player =
      findPlayer(
        room,
        identifier
      );

    if (!player) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Player not found.'
        });
    }

    player.alive =
      false;

    player.hearts =
      0;

    setTimeout(
      () => {

        if (
          room.players.has(
            player.id
          )
        ) {

          room.respawn(
            player
          );

          broadcastRoom(
            room
          );
        }

      },
      1600
    );

    broadcastRoom(room);

    res.json({
      ok: true,
      player: player.name
    });
  }
);

app.post(
  '/api/owner/add-bot',
  (req, res) => {

    const {
      room: roomId,
      name,
      color,
      hat
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Server not found.'
        });
    }

    if (
      room.players.size >=
      MAX_PLAYERS_PER_ROOM
    ) {

      return res.status(400)
        .json({
          ok: false,
          error:
            'That server is full.'
        });
    }

    const botId =
      'bot-' +
      Date.now() +
      '-' +
      Math.floor(
        Math.random() *
        100000
      );

    const bot =
      room.addPlayer(
        botId,
        sanitizeName(
          name ||
          'SKULP Bot'
        ),
        sanitizeColor(
          color
        ),
        sanitizeHat(
          hat
        ),
        true
      );

    broadcastRoom(room);

    res.json({
      ok: true,

      bot: {
        id: bot.id,
        name: bot.name
      }
    });
  }
);

app.post(
  '/api/owner/remove-bot',
  (req, res) => {

    const {
      room: roomId,
      player: identifier
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Server not found.'
        });
    }

    const player =
      findPlayer(
        room,
        identifier
      );

    if (!player) {

      return res.status(404)
        .json({
          ok: false,
          error:
            'Player not found.'
        });
    }

    if (!player.isBot) {

      return res.status(400)
        .json({
          ok: false,
          error:
            'That player is not a bot.'
        });
    }

    room.removePlayer(
      player.id
    );

    broadcastRoom(room);

    res.json({
      ok: true,
      removed:
        player.name
    });
  }
);

io.on(
  'connection',
  socket => {

    let currentRoomId =
      null;

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

          const error = {
            ok: false,
            error:
              'Server not found.'
          };

          if (
            typeof ack ===
            'function'
          ) {
            ack(error);
          }

          socket.emit(
            'join-error',
            error
          );

          return;
        }

        if (
          room.players.size >=
          MAX_PLAYERS_PER_ROOM
        ) {

          const error = {
            ok: false,
            error:
              'That server is full.'
          };

          if (
            typeof ack ===
            'function'
          ) {
            ack(error);
          }

          socket.emit(
            'join-error',
            error
          );

          return;
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

        room.addPlayer(
          socket.id,
          name,
          color,
          hat
        );

        currentRoomId =
          roomId;

        socket.join(
          roomId
        );

        const joinData = {

          ok: true,

          selfId:
            socket.id,

          arena:
            ARENA,

          roomName:
            room.name,

          roomId:
            room.id
        };

        if (
          typeof ack ===
          'function'
        ) {
          ack(joinData);
        }

        socket.emit(
          'joined',
          joinData
        );

        socket.emit(
          'state',
          room.snapshot()
        );

        broadcastRoom(room);
      }
    );

    socket.on(
      'input',
      payload => {

        if (
          !currentRoomId
        ) return;

        const room =
          rooms.get(
            currentRoomId
          );

        if (!room) return;

        const player =
          room.players.get(
            socket.id
          );

        if (!player) return;

        player.dx =
          clamp(
            Number(
              payload?.dx
            ) || 0,
            -1,
            1
          );

        player.dy =
          clamp(
            Number(
              payload?.dy
            ) || 0,
            -1,
            1
          );

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

    socket.on(
      'bite',
      () => {

        if (
          !currentRoomId
        ) return;

        const room =
          rooms.get(
            currentRoomId
          );

        if (!room) return;

        const result =
          room.handleBite(
            socket.id
          );

        if (
          result?.event &&
          result.target
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
                result.target.name
            }
          );
        }
      }
    );

    socket.on(
      'ping-probe',
      (_payload, ack) => {

        if (
          typeof ack ===
          'function'
        ) {
          ack(Date.now());
        }
      }
    );

    socket.on(
      'disconnect',
      () => {

        if (
          !currentRoomId
        ) return;

        const room =
          rooms.get(
            currentRoomId
          );

        if (!room) return;

        room.removePlayer(
          socket.id
        );

        broadcastRoom(
          room
        );
      }
    );
  }
);

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

    dtSec =
      Math.min(
        dtSec,
        0.1
      );

    for (
      const room of rooms.values()
    ) {

      if (
        room.players.size === 0
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

setInterval(
  () => {

    for (
      const room of rooms.values()
    ) {

      if (
        room.players.size === 0
      ) {
        continue;
      }

      io.to(
        room.id
      ).emit(
        'state',
        room.snapshot()
      );
    }

  },
  BROADCAST_MS
);

server.listen(
  PORT,
  () => {

    console.log(
      `SKULP server listening on port ${PORT}`
    );
  }
);
