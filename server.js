const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 1000 / 60;
const CANVAS_W = 1200;
const CANVAS_H = 800;

// ─── Game Config ──────────────────────────────────────────────
const CONFIG = {
  WAVE_DURATION: 10000,
  ZOMBIE_BASE_COUNT: 5,
  ZOMBIE_SPEED_BASE: 1.3,
  BOSS_HEALTH_MULTIPLIER: 15,
  PLAYER_SPEED: 4.8,
  BULLET_SPEED: 11,
  FIRE_RATE: 70,
  QNA_MULTIPLIER: 2,
  MAX_BULLETS: 50,
  DAMAGE_COOLDOWN: 500,
  SPAWN_MARGIN: 150,
};

// ─── Game State ───────────────────────────────────────────────
let gameState = null;
let players = {};
let bullets = [];
let zombies = [];
let lastDamageTime = {};
let nextPlayerId = 1;
let wss = null;

function createGameState() {
  return {
    running: false,
    wave: 1,
    waveStartTime: 0,
    isBossWave: false,
    isQNAWave: false,
    waveType: 'Normal',
    playerCount: 0,
  };
}

function createPlayerData(id) {
  return {
    id,
    x: Math.random() * (CANVAS_W - 100) + 50,
    y: Math.random() * (CANVAS_H - 100) + 50,
    angle: 0,
    health: 100,
    maxHealth: 100,
    score: 0,
    kills: 0,
    radius: 22,
    connected: true,
    // input
    mx: 0,
    my: 0,
    mouseX: 0,
    mouseY: 0,
    shooting: false,
    lastFireTime: 0,
    lastDamageTime: 0,
  };
}

// ─── Spawning ─────────────────────────────────────────────────
function getSpawnPos(margin) {
  const side = Math.floor(Math.random() * 4);
  let x, y;
  switch (side) {
    case 0: x = -margin; y = Math.random() * CANVAS_H; break;
    case 1: x = CANVAS_W + margin; y = Math.random() * CANVAS_H; break;
    case 2: x = Math.random() * CANVAS_W; y = -margin; break;
    default: x = Math.random() * CANVAS_W; y = CANVAS_H + margin;
  }
  return { x, y };
}

function spawnSingleZombie(isBoss) {
  const pos = getSpawnPos(isBoss ? 60 : 40);
  const speedMult = 1 + (gameState.wave * 0.07);
  const baseSpeed = isBoss ? CONFIG.ZOMBIE_SPEED_BASE * 0.55 : CONFIG.ZOMBIE_SPEED_BASE;
  zombies.push({
    x: pos.x, y: pos.y,
    radius: isBoss ? 52 : 26,
    speed: baseSpeed * speedMult * (0.85 + Math.random() * 0.3),
    health: isBoss ? gameState.wave * CONFIG.BOSS_HEALTH_MULTIPLIER : 2 + Math.floor(gameState.wave / 3),
    maxHealth: isBoss ? gameState.wave * CONFIG.BOSS_HEALTH_MULTIPLIER : 2 + Math.floor(gameState.wave / 3),
    isBoss,
    damage: isBoss ? 22 : 8,
    animOffset: Math.random() * Math.PI * 2,
    hitFlash: 0,
    lastHitTime: 0,
  });
}

function spawnBoss() {
  const pos = getSpawnPos(60);
  zombies.push({
    x: pos.x, y: pos.y, radius: 52,
    speed: CONFIG.ZOMBIE_SPEED_BASE * 0.58,
    health: gameState.wave * CONFIG.BOSS_HEALTH_MULTIPLIER,
    maxHealth: gameState.wave * CONFIG.BOSS_HEALTH_MULTIPLIER,
    isBoss: true, damage: 22,
    animOffset: 0, hitFlash: 0, lastHitTime: 0,
  });
}

function spawnZombies() {
  if (!gameState) return;
  let count = CONFIG.ZOMBIE_BASE_COUNT * gameState.wave;
  if (gameState.isQNAWave) count *= CONFIG.QNA_MULTIPLIER;
  count = Math.min(Math.floor(count), 35);
  if (gameState.isBossWave) {
    spawnBoss();
    const n = gameState.isQNAWave ? count : Math.max(2, Math.floor(count / 3));
    for (let i = 0; i < n; i++) spawnSingleZombie(false);
  } else {
    for (let i = 0; i < count; i++) spawnSingleZombie(false);
  }
  gameState.zombieSpawned = true;
}

// ─── Wave Management ─────────────────────────────────────────
function nextWave() {
  if (!gameState || !gameState.running) return;
  gameState.wave++;
  gameState.isBossWave = gameState.wave % 3 === 0;
  gameState.isQNAWave = gameState.wave % 5 === 0;
  gameState.waveStartTime = Date.now();

  if (gameState.isQNAWave) {
    gameState.waveType = 'QNA SESSION!';
  } else if (gameState.isBossWave) {
    gameState.waveType = 'BOSS WAVE!';
  } else {
    gameState.waveType = 'Normal';
  }

  // heal all players a bit
  for (const pid in players) {
    const p = players[pid];
    if (p.connected) p.health = Math.min(p.maxHealth, p.health + 15);
  }

  spawnZombies();
  broadcastGameState();
}

function checkWave() {
  if (!gameState || !gameState.running) return;
  const elapsed = Date.now() - gameState.waveStartTime;
  if (elapsed >= CONFIG.WAVE_DURATION || zombies.length === 0) {
    nextWave();
  }
}

// ─── Update ───────────────────────────────────────────────────
function updatePlayers() {
  const now = Date.now();
  for (const pid in players) {
    const p = players[pid];
    if (!p.connected) continue;

    const mx = p.mx || 0;
    const my = p.my || 0;
    const mag = Math.sqrt(mx * mx + my * my);
    let dx = mx, dy = my;
    if (mag > 1) { dx /= mag; dy /= mag; }

    p.x += dx * CONFIG.PLAYER_SPEED;
    p.y += dy * CONFIG.PLAYER_SPEED;
    p.x = Math.max(p.radius, Math.min(CANVAS_W - p.radius, p.x));
    p.y = Math.max(p.radius, Math.min(CANVAS_H - p.radius, p.y));

    p.angle = Math.atan2(p.mouseY - p.y, p.mouseX - p.x);

    if (p.shooting) {
      if (now - p.lastFireTime >= CONFIG.FIRE_RATE && bullets.length < CONFIG.MAX_BULLETS) {
        p.lastFireTime = now;
        bullets.push({
          x: p.x + Math.cos(p.angle) * 28,
          y: p.y + Math.sin(p.angle) * 28,
          vx: Math.cos(p.angle) * CONFIG.BULLET_SPEED,
          vy: Math.sin(p.angle) * CONFIG.BULLET_SPEED,
          radius: 5,
          damage: 1,
          playerId: pid,
        });
      }
    }
  }
}

function updateBullets() {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx;
    b.y += b.vy;
    if (b.x < -30 || b.x > CANVAS_W + 30 || b.y < -30 || b.y > CANVAS_H + 30) {
      bullets.splice(i, 1);
      continue;
    }
    for (let j = zombies.length - 1; j >= 0; j--) {
      const z = zombies[j];
      const dx = b.x - z.x;
      const dy = b.y - z.y;
      if (dx * dx + dy * dy < (b.radius + z.radius) ** 2) {
        z.health -= b.damage;
        z.hitFlash = 1;
        bullets.splice(i, 1);
        if (z.health <= 0) {
          const pts = z.isBoss ? 500 : 100;
          // award points to the player who shot
          if (b.playerId && players[b.playerId]) {
            players[b.playerId].score += pts;
            players[b.playerId].kills++;
          }
          zombies.splice(j, 1);
        }
        break;
      }
    }
  }
}

function updateZombies() {
  const now = Date.now();
  // find nearest player for each zombie
  for (const z of zombies) {
    let target = null;
    let minDist = Infinity;
    for (const pid in players) {
      const p = players[pid];
      if (!p.connected) continue;
      const dx = p.x - z.x;
      const dy = p.y - z.y;
      const dist = dx * dx + dy * dy;
      if (dist < minDist) {
        minDist = dist;
        target = p;
      }
    }
    if (target) {
      const dx = target.x - z.x;
      const dy = target.y - z.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 1) {
        z.x += (dx / dist) * z.speed;
        z.y += (dy / dist) * z.speed;
      }
      // damage player
      if (dist < z.radius + target.radius - 5 && dist > 0) {
        if (now - target.lastDamageTime > CONFIG.DAMAGE_COOLDOWN && now - z.lastHitTime > CONFIG.DAMAGE_COOLDOWN) {
          target.health -= z.damage;
          target.lastDamageTime = now;
          z.lastHitTime = now;
          const pushAngle = Math.atan2(dy, dx);
          target.x -= Math.cos(pushAngle) * 15;
          target.y -= Math.sin(pushAngle) * 15;
          target.x = Math.max(target.radius, Math.min(CANVAS_W - target.radius, target.x));
          target.y = Math.max(target.radius, Math.min(CANVAS_H - target.radius, target.y));
        }
      }
    }
    if (z.hitFlash > 0) z.hitFlash -= 0.005;
  }

  // check game over
  for (const pid in players) {
    const p = players[pid];
    if (p.connected && p.health <= 0) {
      p.health = 0;
      p.connected = false; // dead
    }
  }

  // if all players dead, stop wave but keep running for spectators
  const aliveCount = Object.values(players).filter(p => p.connected).length;
  if (aliveCount === 0 && Object.keys(players).length > 0) {
    gameState.running = false;
  }
}

// ─── Broadcast ────────────────────────────────────────────────
function broadcastGameState() {
  if (!wss) return;
  const now = Date.now();
  const alivePlayers = {};
  for (const pid in players) {
    const p = players[pid];
    alivePlayers[pid] = {
      id: p.id,
      x: p.x, y: p.y, angle: p.angle,
      health: p.health, maxHealth: p.maxHealth,
      score: p.score, kills: p.kills,
      radius: p.radius,
      connected: p.connected,
    };
  }

  const state = {
    type: 'state',
    players: alivePlayers,
    zombies: zombies.map(z => ({
      x: z.x, y: z.y, radius: z.radius,
      health: z.health, maxHealth: z.maxHealth,
      isBoss: z.isBoss, hitFlash: z.hitFlash,
      animOffset: z.animOffset,
    })),
    bullets: bullets.map(b => ({
      x: b.x, y: b.y, vx: b.vx, vy: b.vy,
      radius: b.radius,
    })),
    wave: gameState ? gameState.wave : 1,
    waveType: gameState ? gameState.waveType : 'Normal',
    isBossWave: gameState ? gameState.isBossWave : false,
    isQNAWave: gameState ? gameState.isQNAWave : false,
    waveStartTime: gameState ? gameState.waveStartTime : 0,
    waveDuration: CONFIG.WAVE_DURATION,
    playerCount: Object.keys(players).length,
    gameOver: !gameState || !gameState.running,
  };

  const data = JSON.stringify(state);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(data);
    }
  });
}

// ─── Game Loop ────────────────────────────────────────────────
let gameLoopInterval = null;

function startGameLoop() {
  if (gameLoopInterval) return;
  gameLoopInterval = setInterval(() => {
    if (gameState && gameState.running) {
      updatePlayers();
      updateBullets();
      updateZombies();
      checkWave();
    }
    broadcastGameState();
  }, TICK_RATE);
}

function stopGameLoop() {
  if (gameLoopInterval) {
    clearInterval(gameLoopInterval);
    gameLoopInterval = null;
  }
}

// ─── Start/Stop Game ─────────────────────────────────────────
function startGame() {
  bullets = [];
  zombies = [];
  gameState = createGameState();
  gameState.running = true;
  gameState.waveStartTime = Date.now();

  // reset all connected players
  for (const pid in players) {
    const p = players[pid];
    p.health = p.maxHealth;
    p.score = 0;
    p.kills = 0;
    p.connected = true;
    p.x = Math.random() * (CANVAS_W - 100) + 50;
    p.y = Math.random() * (CANVAS_H - 100) + 50;
    p.lastDamageTime = 0;
    p.lastFireTime = 0;
  }

  spawnZombies();
  startGameLoop();
}

// ─── Express App ──────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname)));

app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);

wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const pid = 'player_' + (nextPlayerId++);
  const player = createPlayerData(pid);
  players[pid] = player;

  console.log(`[+] ${pid} connected (total: ${Object.keys(players).length})`);

  // send init message
  ws.send(JSON.stringify({
    type: 'init',
    playerId: pid,
    canvasWidth: CANVAS_W,
    canvasHeight: CANVAS_H,
    config: CONFIG,
  }));

  // start game if this is the first player
  if (!gameState || !gameState.running) {
    startGame();
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'input' && players[pid]) {
        const p = players[pid];
        p.mx = msg.mx || 0;
        p.my = msg.my || 0;
        p.mouseX = msg.mouseX || 0;
        p.mouseY = msg.mouseY || 0;
        p.shooting = msg.shooting || false;
      }
    } catch (e) { /* ignore malformed */ }
  });

  ws.on('close', () => {
    console.log(`[-] ${pid} disconnected`);
    if (players[pid]) {
      players[pid].connected = false;
    }
    // clean up dead players after a delay
    setTimeout(() => {
      if (players[pid] && !players[pid].connected) {
        delete players[pid];
      }
      const alive = Object.values(players).filter(p => p.connected).length;
      if (alive === 0) {
        // stop game if no one is playing
        gameState.running = false;
        zombies = [];
        bullets = [];
        stopGameLoop();
      }
    }, 5000);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const addr = server.address();
  console.log(`🚀 Chandan vs Students server running on port ${addr.port}`);
  console.log(`   Local:    http://localhost:${addr.port}`);
  console.log(`   Network:  http://${require('os').hostname()}:${addr.port}`);
});
