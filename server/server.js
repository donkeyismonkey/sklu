const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 4000;

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ============================================================
// CONFIG
// ============================================================

const ARENA = {
  width: 3000,
  height: 3000
};

const TICK_HZ = 30;
const TICK_MS = 1000 / TICK_HZ;

const BROADCAST_HZ = 20;
const BROADCAST_MS = 1000 / BROADCAST_HZ;

const MAX_PLAYERS_PER_ROOM = 40;

const PLAYER_RADIUS = 32;

const PLAYER_SPEED = 255;
const MIN_PLAYER_SPEED = 0;
const MAX_PLAYER_SPEED = 2000;

const BONE_RADIUS = 18;
const BONE_TARGET_COUNT = 60;
const BONE_RESPAWN_MS = 4000;

const BITE_RANGE = 75;
const BITE_COOLDOWN_MS = 500;
const BITE_ARC_DEG = 100;

const HEART_MAX = 3;
const RESPAWN_INVULN_MS = 1800;

const MAX_NAME_LEN = 20;

const ROOM_NAMES = [
  "Junkyard Prime",
  "Rustbelt Court",
  "The Bonepit",
  "Alley Howl"
];

const HAT_IDS = [
  "none",
  "party",
  "crown",
  "bandana",
  "halo",
  "tinfoil"
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
  if (typeof raw !== "string") {
    return "Stray Dog";
  }

  const trimmed = raw
    .replace(/[^\w \-'!?]/g, "")
    .trim()
    .slice(0, MAX_NAME_LEN);

  return trimmed.length ? trimmed : "Stray Dog";
}

function sanitizeColor(raw) {
  if (
    typeof raw === "string" &&
    /^#[0-9a-fA-F]{6}$/.test(raw)
  ) {
    return raw;
  }

  return "#d97757";
}

function sanitizeHat(raw) {
  return HAT_IDS.includes(raw) ? raw : "none";
}

function cleanNumber(value, fallback = 0) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return n;
}

function rgbToHex(r, g, b) {
  r = clamp(Math.floor(cleanNumber(r)), 0, 255);
  g = clamp(Math.floor(cleanNumber(g)), 0, 255);
  b = clamp(Math.floor(cleanNumber(b)), 0, 255);

  return (
    "#" +
    [r, g, b]
      .map(v => v.toString(16).padStart(2, "0"))
      .join("")
  );
}

function hexToRgb(hex) {
  const clean = String(hex).replace("#", "");

  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    return {
      r: 217,
      g: 119,
      b: 87
    };
  }

  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16)
  };
}

// ============================================================
// ROOM
// ============================================================

class Room {
  constructor(id, index) {
    this.id = id;
    this.name = ROOM_NAMES[index] || `Server ${index + 1}`;

    this.players = new Map();

    this.bones = new Map();

    this.nextBoneId = 1;

    for (let i = 0; i < BONE_TARGET_COUNT; i++) {
      this.spawnBone();
    }
  }

  // ----------------------------------------------------------
  // BONES
  // ----------------------------------------------------------

  spawnBone() {
    const id = "b" + this.nextBoneId++;

    const bone = {
      id,

      x: randRange(
        BONE_RADIUS,
        ARENA.width - BONE_RADIUS
      ),

      y: randRange(
        BONE_RADIUS,
        ARENA.height - BONE_RADIUS
      )
    };

    this.bones.set(id, bone);

    return bone;
  }

  dropBonesAt(x, y, count) {
    count = clamp(
      Math.floor(cleanNumber(count)),
      0,
      500
    );

    for (let i = 0; i < count; i++) {
      const id = "b" + this.nextBoneId++;

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
        )
      });
    }
  }

  // ----------------------------------------------------------
  // PLAYERS
  // ----------------------------------------------------------

  addPlayer(
    socketId,
    name,
    color,
    hat,
    isBot = false
  ) {
    const safeColor = sanitizeColor(color);

    const player = {
      id: socketId,

      name: sanitizeName(name),

      color: safeColor,

      rgb: hexToRgb(safeColor),

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

      botThinkAt: 0,

      botTargetId: null,

      // OWNER CONTROL
      speed: PLAYER_SPEED
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
  // BOT AI
  // ----------------------------------------------------------

  updateBots(now) {
    for (const bot of this.players.values()) {
      if (!bot.isBot) continue;
      if (!bot.alive) continue;

      if (now < bot.botThinkAt) {
        continue;
      }

      bot.botThinkAt =
        now +
        250 +
        Math.random() * 400;

      let target = null;
      let closestDistance = Infinity;

      // Find closest bone
      for (const bone of this.bones.values()) {
        const distance = Math.hypot(
          bot.x - bone.x,
          bot.y - bone.y
        );

        if (distance < closestDistance) {
          closestDistance = distance;
          target = bone;
        }
      }

      // Sometimes chase a real player
      if (Math.random() < 0.40) {
        let closestPlayer = null;
        let closestPlayerDistance =
          Infinity;

        for (const player of this.players.values()) {
          if (player.id === bot.id) {
            continue;
          }

          if (player.isBot) {
            continue;
          }

          if (!player.alive) {
            continue;
          }

          const distance = Math.hypot(
            bot.x - player.x,
            bot.y - player.y
          );

          if (
            distance <
            closestPlayerDistance
          ) {
            closestPlayerDistance =
              distance;

            closestPlayer = player;
          }
        }

        if (closestPlayer) {
          target = closestPlayer;

          closestDistance =
            closestPlayerDistance;

          bot.botTargetId =
            closestPlayer.id;
        }
      }

      if (!target) {
        bot.dx =
          Math.random() * 2 - 1;

        bot.dy =
          Math.random() * 2 - 1;

        continue;
      }

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

      if (
        !target.isBot &&
        distance <= BITE_RANGE
      ) {
        const result =
          this.handleBite(bot.id);

        if (
          result &&
          result.event &&
          result.target
        ) {
          io.to(this.id).emit(
            "event",
            {
              type: result.event,

              attacker:
                result.attacker.name,

              target:
                result.target.name
            }
          );
        }
      }
    }
  }

  // ----------------------------------------------------------
  // GAME TICK
  // ----------------------------------------------------------

  tick(dtSec) {
    const now = Date.now();

    this.updateBots(now);

    // Movement
    for (const player of this.players.values()) {
      if (!player.alive) {
        continue;
      }

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

        player.x = clamp(
          player.x +
            nx *
              player.speed *
              dtSec,

          PLAYER_RADIUS,

          ARENA.width -
            PLAYER_RADIUS
        );

        player.y = clamp(
          player.y +
            ny *
              player.speed *
              dtSec,

          PLAYER_RADIUS,

          ARENA.height -
            PLAYER_RADIUS
        );

        if (!player.isBot) {
          player.facing =
            Math.atan2(ny, nx);
        }
      }
    }

    // Bone collection
    for (const player of this.players.values()) {
      if (!player.alive) {
        continue;
      }

      for (const bone of this.bones.values()) {
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

    // Keep the map populated
    while (
      this.bones.size <
      BONE_TARGET_COUNT
    ) {
      this.spawnBone();
    }
  }

  // ----------------------------------------------------------
  // BITE
  // ----------------------------------------------------------

  handleBite(attackerId) {
    const now = Date.now();

    const attacker =
      this.players.get(
        attackerId
      );

    if (!attacker) {
      return null;
    }

    if (!attacker.alive) {
      return null;
    }

    if (
      now -
        attacker.lastBiteAt <
      BITE_COOLDOWN_MS
    ) {
      return null;
    }

    attacker.lastBiteAt = now;

    let target = null;

    let bestDistance = Infinity;

    for (const player of this.players.values()) {
      if (
        player.id === attacker.id
      ) {
        continue;
      }

      if (!player.alive) {
        continue;
      }

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

      let difference =
        Math.abs(
          targetAngle -
            attacker.facing
        );

      if (difference > Math.PI) {
        difference =
          Math.PI * 2 -
          difference;
      }

      const biteArc =
        (BITE_ARC_DEG *
          Math.PI /
          180) /
        2;

      if (
        difference >
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

        target = player;
      }
    }

    if (!target) {
      return {
        attacker,
        target: null
      };
    }

    // Steal a bone first
    if (target.bones > 0) {
      target.bones -= 1;

      attacker.bones += 1;

      return {
        attacker,
        target,
        event: "steal"
      };
    }

    // Damage
    target.hearts -= 1;

    if (target.hearts <= 0) {
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
          this.respawn(target);
        }
      }, 1600);

      return {
        attacker,
        target,
        event: "kill"
      };
    }

    return {
      attacker,
      target,
      event: "hit"
    };
  }

  // ----------------------------------------------------------
  // SNAPSHOT
  // ----------------------------------------------------------

  snapshot() {
    return {
      arena: ARENA,

      players:
        Array.from(
          this.players.values()
        ).map(p => ({
          id: p.id,

          name: p.name,

          color: p.color,

          rgb: p.rgb,

          hat: p.hat,

          x: Math.round(p.x),

          y: Math.round(p.y),

          facing:
            Math.round(
              p.facing * 100
            ) / 100,

          hearts: p.hearts,

          bones: p.bones,

          alive: p.alive,

          invuln:
            Date.now() <
            p.invulnUntil,

          kills: p.kills,

          isBot: !!p.isBot,

          speed: p.speed
        })),

      bones:
        Array.from(
          this.bones.values()
        )
    };
  }

  // ----------------------------------------------------------
  // BOT LIST
  // ----------------------------------------------------------

  getBots() {
    return Array.from(
      this.players.values()
    )
      .filter(
        player =>
          player.isBot
      )
      .map(player => ({
        id: player.id,

        name: player.name,

        color: player.color,

        hat: player.hat,

        speed: player.speed,

        bones: player.bones
      }));
  }
}

// ============================================================
// ROOMS
// ============================================================

const rooms = new Map();

for (let i = 0; i < 4; i++) {
  const id = `server-${i + 1}`;

  rooms.set(
    id,
    new Room(id, i)
  );
}

// ============================================================
// PLAYER LOOKUP
// ============================================================

function findPlayer(room, identifier) {
  if (!identifier) {
    return null;
  }

  const value =
    String(identifier);

  // ID lookup
  let player =
    room.players.get(value);

  if (player) {
    return player;
  }

  // Name lookup
  const wantedName =
    value.toLowerCase();

  for (const p of room.players.values()) {
    if (
      p.name.toLowerCase() ===
      wantedName
    ) {
      return p;
    }
  }

  return null;
}

// ============================================================
// BROADCAST
// ============================================================

function broadcastRoom(room) {
  io.to(room.id).emit(
    "state",
    room.snapshot()
  );

  io.to(room.id).emit(
    "lobby-update",
    {
      room: room.id,

      players:
        room.players.size,

      maxPlayers:
        MAX_PLAYERS_PER_ROOM,

      bots:
        room.getBots().length
    }
  );
}

// ============================================================
// BASIC API
// ============================================================

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "SKULP Server",
    version: "owner-controls",
    rooms: rooms.size
  });
});

app.get("/api/ping", (req, res) => {
  res.json({
    ok: true,
    pong: true,
    time: Date.now()
  });
});

// ============================================================
// SERVER LIST
// ============================================================

app.get("/api/servers", (req, res) => {
  const servers =
    Array.from(
      rooms.values()
    ).map(room => ({
      id: room.id,

      name: room.name,

      players:
        room.players.size,

      maxPlayers:
        MAX_PLAYERS_PER_ROOM,

      bots:
        room.getBots().length
    }));

  res.json({
    ok: true,
    servers
  });
});

// ============================================================
// ALL PLAYERS
// ============================================================

app.get("/api/players", (req, res) => {
  const room =
    rooms.get(
      req.query.room
    );

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Server not found."
    });
  }

  const players =
    Array.from(
      room.players.values()
    ).map(player => ({
      id: player.id,

      name: player.name,

      isBot: !!player.isBot,

      bones: player.bones,

      speed: player.speed,

      color: player.color,

      rgb: player.rgb,

      alive: player.alive,

      hearts: player.hearts,

      kills: player.kills
    }));

  res.json({
    ok: true,

    room: room.id,

    players
  });
});

// ============================================================
// BOT API
// ============================================================

app.get("/api/bots", (req, res) => {
  const room =
    rooms.get(
      req.query.room
    );

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Server not found."
    });
  }

  res.json({
    ok: true,

    room: room.id,

    bots: room.getBots()
  });
});

// ============================================================
// ADD BOTS
// ============================================================

app.post("/api/bots/add", (req, res) => {
  const {
    room: roomId,
    count
  } = req.body || {};

  const room =
    rooms.get(roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Server not found."
    });
  }

  let amount =
    Math.floor(
      cleanNumber(count, 1)
    );

  amount =
    clamp(
      amount,
      1,
      MAX_PLAYERS_PER_ROOM -
        room.players.size
    );

  for (let i = 0; i < amount; i++) {
    const botId =
      `bot-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

    const botNumber =
      room.getBots().length + 1;

    const colors = [
      "#ff4d4d",
      "#4d8dff",
      "#4dff88",
      "#d84dff",
      "#ffd24d",
      "#4de7ff"
    ];

    room.addPlayer(
      botId,

      `BOT ${botNumber}`,

      colors[
        botNumber %
          colors.length
      ],

      "none",

      true
    );
  }

  broadcastRoom(room);

  res.json({
    ok: true,

    added: amount,

    players:
      room.players.size,

    maxPlayers:
      MAX_PLAYERS_PER_ROOM
  });
});

// ============================================================
// REMOVE BOTS
// ============================================================

app.post("/api/bots/remove", (req, res) => {
  const {
    room: roomId,
    count
  } = req.body || {};

  const room =
    rooms.get(roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Server not found."
    });
  }

  let amount =
    Math.floor(
      cleanNumber(count, 1)
    );

  amount =
    Math.max(
      1,
      amount
    );

  const bots =
    Array.from(
      room.players.values()
    )
      .filter(
        player =>
          player.isBot
      );

  const removeCount =
    Math.min(
      amount,
      bots.length
    );

  for (
    let i = 0;
    i < removeCount;
    i++
  ) {
    room.removePlayer(
      bots[i].id
    );
  }

  broadcastRoom(room);

  res.json({
    ok: true,

    removed:
      removeCount,

    botsRemaining:
      room.getBots().length
  });
});

// ============================================================
// REMOVE ALL BOTS
// ============================================================

app.post(
  "/api/bots/remove-all",
  (req, res) => {
    const {
      room: roomId
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {
      return res.status(404).json({
        ok: false,
        error: "Server not found."
      });
    }

    let removed = 0;

    for (
      const player of
      room.players.values()
    ) {
      if (player.isBot) {
        room.removePlayer(
          player.id
        );

        removed++;
      }
    }

    broadcastRoom(room);

    res.json({
      ok: true,
      removed
    });
  }
);

// ============================================================
// OWNER: GIVE BONES
// ============================================================

app.post(
  "/api/owner/give-bones",
  (req, res) => {
    const {
      room: roomId,
      player: playerIdentifier,
      amount
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {
      return res.status(404).json({
        ok: false,
        error: "Server not found."
      });
    }

    const player =
      findPlayer(
        room,
        playerIdentifier
      );

    if (!player) {
      return res.status(404).json({
        ok: false,
        error: "Player not found."
      });
    }

    const bones =
      clamp(
        Math.floor(
          cleanNumber(
            amount,
            0
          )
        ),
        0,
        100000
      );

    player.bones += bones;

    broadcastRoom(room);

    res.json({
      ok: true,

      player: {
        id: player.id,
        name: player.name
      },

      bonesAdded: bones,

      bones:
        player.bones
    });
  }
);

// ============================================================
// OWNER: SET SPEED
// ============================================================

app.post(
  "/api/owner/set-speed",
  (req, res) => {
    const {
      room: roomId,
      player: playerIdentifier,
      speed
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {
      return res.status(404).json({
        ok: false,
        error: "Server not found."
      });
    }

    const player =
      findPlayer(
        room,
        playerIdentifier
      );

    if (!player) {
      return res.status(404).json({
        ok: false,
        error: "Player not found."
      });
    }

    const newSpeed =
      clamp(
        cleanNumber(
          speed,
          PLAYER_SPEED
        ),
        MIN_PLAYER_SPEED,
        MAX_PLAYER_SPEED
      );

    player.speed =
      newSpeed;

    broadcastRoom(room);

    res.json({
      ok: true,

      player: {
        id: player.id,
        name: player.name
      },

      speed:
        player.speed
    });
  }
);

// ============================================================
// OWNER: RESET PLAYER SPEED
// ============================================================

app.post(
  "/api/owner/reset-speed",
  (req, res) => {
    const {
      room: roomId,
      player: playerIdentifier
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {
      return res.status(404).json({
        ok: false,
        error: "Server not found."
      });
    }

    const player =
      findPlayer(
        room,
        playerIdentifier
      );

    if (!player) {
      return res.status(404).json({
        ok: false,
        error: "Player not found."
      });
    }

    player.speed =
      PLAYER_SPEED;

    broadcastRoom(room);

    res.json({
      ok: true,

      speed:
        player.speed
    });
  }
);

// ============================================================
// OWNER: SET RGB COLOR
// ============================================================

app.post(
  "/api/owner/set-color",
  (req, res) => {
    const {
      room: roomId,
      player: playerIdentifier,
      r,
      g,
      b
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {
      return res.status(404).json({
        ok: false,
        error: "Server not found."
      });
    }

    const player =
      findPlayer(
        room,
        playerIdentifier
      );

    if (!player) {
      return res.status(404).json({
        ok: false,
        error: "Player not found."
      });
    }

    const rgb = {
      r: clamp(
        Math.floor(
          cleanNumber(r)
        ),
        0,
        255
      ),

      g: clamp(
        Math.floor(
          cleanNumber(g)
        ),
        0,
        255
      ),

      b: clamp(
        Math.floor(
          cleanNumber(b)
        ),
        0,
        255
      )
    };

    player.rgb = rgb;

    player.color =
      rgbToHex(
        rgb.r,
        rgb.g,
        rgb.b
      );

    broadcastRoom(room);

    res.json({
      ok: true,

      player: {
        id: player.id,
        name: player.name
      },

      color:
        player.color,

      rgb:
        player.rgb
    });
  }
);

// ============================================================
// OWNER: RESET COLOR
// ============================================================

app.post(
  "/api/owner/reset-color",
  (req, res) => {
    const {
      room: roomId,
      player: playerIdentifier
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {
      return res.status(404).json({
        ok: false,
        error: "Server not found."
      });
    }

    const player =
      findPlayer(
        room,
        playerIdentifier
      );

    if (!player) {
      return res.status(404).json({
        ok: false,
        error: "Player not found."
      });
    }

    player.color =
      "#d97757";

    player.rgb =
      hexToRgb(
        player.color
      );

    broadcastRoom(room);

    res.json({
      ok: true,

      color:
        player.color,

      rgb:
        player.rgb
    });
  }
);

// ============================================================
// OWNER: SET EVERYONE'S SPEED
// ============================================================

app.post(
  "/api/owner/set-all-speed",
  (req, res) => {
    const {
      room: roomId,
      speed
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {
      return res.status(404).json({
        ok: false,
        error: "Server not found."
      });
    }

    const newSpeed =
      clamp(
        cleanNumber(
          speed,
          PLAYER_SPEED
        ),
        MIN_PLAYER_SPEED,
        MAX_PLAYER_SPEED
      );

    let changed = 0;

    for (
      const player of
      room.players.values()
    ) {
      player.speed =
        newSpeed;

      changed++;
    }

    broadcastRoom(room);

    res.json({
      ok: true,

      speed:
        newSpeed,

      playersChanged:
        changed
    });
  }
);

// ============================================================
// OWNER: RESET EVERYONE'S SPEED
// ============================================================

app.post(
  "/api/owner/reset-all-speed",
  (req, res) => {
    const {
      room: roomId
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {
      return res.status(404).json({
        ok: false,
        error: "Server not found."
      });
    }

    let changed = 0;

    for (
      const player of
      room.players.values()
    ) {
      player.speed =
        PLAYER_SPEED;

      changed++;
    }

    broadcastRoom(room);

    res.json({
      ok: true,

      speed:
        PLAYER_SPEED,

      playersChanged:
        changed
    });
  }
);

// ============================================================
// OWNER: SET EVERYONE'S RGB
// ============================================================

app.post(
  "/api/owner/set-all-color",
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
      return res.status(404).json({
        ok: false,
        error: "Server not found."
      });
    }

    const rgb = {
      r: clamp(
        Math.floor(
          cleanNumber(r)
        ),
        0,
        255
      ),

      g: clamp(
        Math.floor(
          cleanNumber(g)
        ),
        0,
        255
      ),

      b: clamp(
        Math.floor(
          cleanNumber(b)
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

    let changed = 0;

    for (
      const player of
      room.players.values()
    ) {
      player.rgb = {
        ...rgb
      };

      player.color =
        color;

      changed++;
    }

    broadcastRoom(room);

    res.json({
      ok: true,

      color,

      rgb,

      playersChanged:
        changed
    });
  }
);

// ============================================================
// OWNER: RESET EVERYONE'S COLOR
// ============================================================

app.post(
  "/api/owner/reset-all-color",
  (req, res) => {
    const {
      room: roomId
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {
      return res.status(404).json({
        ok: false,
        error: "Server not found."
      });
    }

    const color =
      "#d97757";

    const rgb =
      hexToRgb(color);

    let changed = 0;

    for (
      const player of
      room.players.values()
    ) {
      player.color =
        color;

      player.rgb = {
        ...rgb
      };

      changed++;
    }

    broadcastRoom(room);

    res.json({
      ok: true,

      color,

      rgb,

      playersChanged:
        changed
    });
  }
);

// ============================================================
// OWNER: SET PLAYER HEARTS
// ============================================================

app.post(
  "/api/owner/set-hearts",
  (req, res) => {
    const {
      room: roomId,
      player: playerIdentifier,
      hearts
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {
      return res.status(404).json({
        ok: false,
        error: "Server not found."
      });
    }

    const player =
      findPlayer(
        room,
        playerIdentifier
      );

    if (!player) {
      return res.status(404).json({
        ok: false,
        error: "Player not found."
      });
    }

    player.hearts =
      clamp(
        Math.floor(
          cleanNumber(
            hearts,
            HEART_MAX
          )
        ),
        0,
        100
      );

    if (player.hearts > 0) {
      player.alive = true;
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

// ============================================================
// OWNER: KILL PLAYER
// ============================================================

app.post(
  "/api/owner/kill",
  (req, res) => {
    const {
      room: roomId,
      player: playerIdentifier
    } = req.body || {};

    const room =
      rooms.get(roomId);

    if (!room) {
      return res.status(404).json({
        ok: false,
        error: "Server not found."
      });
    }

    const player =
      findPlayer(
        room,
        playerIdentifier
      );

    if (!player) {
      return res.status(404).json({
        ok: false,
        error: "Player not found."
      });
    }

    player.hearts = 0;

    player.alive = false;

    const droppedBones =
      player.bones;

    player.bones = 0;

    room.dropBonesAt(
      player.x,
      player.y,
      droppedBones
    );

    setTimeout(() => {
      if (
        room.players.has(
          player.id
        )
      ) {
        room.respawn(player);
        broadcastRoom(room);
      }
    }, 1600);

    broadcastRoom(room);

    res.json({
      ok: true,

      player: player.name,

      message:
        "Player killed."
    });
  }
);

// ============================================================
// SOCKET.IO
// ============================================================

io.on(
  "connection",
  socket => {
    console.log(
      "[CONNECT]",
      socket.id
    );

    socket.on(
      "join",
      data => {
        data =
          data || {};

        const roomId =
          data.room ||
          "server-1";

        const room =
          rooms.get(roomId);

        if (!room) {
          socket.emit(
            "join-error",
            {
              error:
                "Server not found."
            }
          );

          return;
        }

        if (
          room.players.size >=
          MAX_PLAYERS_PER_ROOM
        ) {
          socket.emit(
            "join-error",
            {
              error:
                "Server is full."
            }
          );

          return;
        }

        const player =
          room.addPlayer(
            socket.id,

            data.name,

            data.color,

            data.hat,

            false
          );

        socket.data.roomId =
          room.id;

        socket.data.playerId =
          player.id;

        socket.join(
          room.id
        );

        socket.emit(
          "joined",
          {
            id: player.id,

            room: room.id,

            roomName:
              room.name,

            maxPlayers:
              MAX_PLAYERS_PER_ROOM
          }
        );

        broadcastRoom(room);

        console.log(
          `[JOIN] ${player.name} -> ${room.id}`
        );
      }
    );

    // --------------------------------------------------------
    // INPUT
    // --------------------------------------------------------

    socket.on(
      "input",
      data => {
        const room =
          rooms.get(
            socket.data.roomId
          );

        if (!room) {
          return;
        }

        const player =
          room.players.get(
            socket.id
          );

        if (!player) {
          return;
        }

        data =
          data || {};

        let dx =
          cleanNumber(
            data.dx,
            0
          );

        let dy =
          cleanNumber(
            data.dy,
            0
          );

        const magnitude =
          Math.hypot(dx, dy);

        if (magnitude > 1) {
          dx /= magnitude;
          dy /= magnitude;
        }

        player.dx = dx;
        player.dy = dy;

        if (
          magnitude >
          0.001
        ) {
          player.facing =
            Math.atan2(
              dy,
              dx
            );
        }
      }
    );

    // --------------------------------------------------------
    // BITE
    // --------------------------------------------------------

    socket.on(
      "bite",
      () => {
        const room =
          rooms.get(
            socket.data.roomId
          );

        if (!room) {
          return;
        }

        const result =
          room.handleBite(
            socket.id
          );

        if (
          result &&
          result.event &&
          result.target
        ) {
          io.to(room.id).emit(
            "event",
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

        broadcastRoom(room);
      }
    );

    // --------------------------------------------------------
    // PING
    // --------------------------------------------------------

    socket.on(
      "ping-probe",
      () => {
        socket.emit(
          "pong-probe",
          {
            time: Date.now()
          }
        );
      }
    );

    // --------------------------------------------------------
    // DISCONNECT
    // --------------------------------------------------------

    socket.on(
      "disconnect",
      () => {
        const room =
          rooms.get(
            socket.data.roomId
          );

        if (!room) {
          return;
        }

        const player =
          room.players.get(
            socket.id
          );

        room.removePlayer(
          socket.id
        );

        broadcastRoom(room);

        console.log(
          `[DISCONNECT] ${
            player
              ? player.name
              : socket.id
          }`
        );
      }
    );
  }
);

// ============================================================
// GAME LOOP
// ============================================================

setInterval(
  () => {
    for (
      const room of
      rooms.values()
    ) {
      room.tick(
        TICK_MS / 1000
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
      const room of
      rooms.values()
    ) {
      if (
        room.players.size > 0
      ) {
        io.to(room.id).emit(
          "state",
          room.snapshot()
        );
      }
    }
  },
  BROADCAST_MS
);

// ============================================================
// START SERVER
// ============================================================

server.listen(
  PORT,
  () => {
    console.log(
      "===================================="
    );

    console.log(
      "        SKULP SERVER ONLINE"
    );

    console.log(
      "===================================="
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Max players per server: ${MAX_PLAYERS_PER_ROOM}`
    );

    console.log(
      "Owner controls: ENABLED"
    );

    console.log(
      "Admin key: NOT REQUIRED"
    );

    console.log(
      "===================================="
    );
  }
);
