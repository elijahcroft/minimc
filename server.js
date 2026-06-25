const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8099);
const ROOT = __dirname;
const players = new Map();
const blockEdits = new Map();
let nextId = 1;

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml; charset=utf-8']
]);

function sendJson(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function broadcast(message, except) {
  const text = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client !== except && client.readyState === WebSocket.OPEN) client.send(text);
  }
}

function sendToId(playerId, message) {
  for (const client of wss.clients) {
    if (client.playerId === playerId) { sendJson(client, message); return; }
  }
}

function sanitizeName(value) {
  const clean = String(value || '').replace(/[^\w .-]/g, '').trim().slice(0, 18);
  return clean || 'Student';
}

function safeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeTransform(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    x: safeNumber(v.x),
    y: safeNumber(v.y),
    z: safeNumber(v.z),
    yaw: safeNumber(v.yaw),
    pitch: safeNumber(v.pitch)
  };
}

function normalizeBlock(message) {
  const x = Math.trunc(Number(message.x));
  const y = Math.trunc(Number(message.y));
  const z = Math.trunc(Number(message.z));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const type = message.type == null ? null : String(message.type).slice(0, 40);
  return { x, y, z, type };
}

// ============================================================ terrain (mirrors client world gen)
function rand(x, z) { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); }
function smooth2(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = rand(xi, zi), b = rand(xi + 1, zi), c = rand(xi, zi + 1), d = rand(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const SEA = 7;
function biomeAt(x, z) { return smooth2(x / 140 + 50, z / 140 + 50); }
function isDesert(x, z) { return biomeAt(x, z) > 0.55; }
function heightAt(x, z) {
  const n = smooth2(x / 22, z / 22) * 1.0 + smooth2(x / 9, z / 9) * 0.35;
  const amp = isDesert(x, z) ? 9 : 16;
  return Math.floor(6 + n / 1.35 * amp);
}
function surfaceY(x, z) { return heightAt(x, z) + 1; }

// ============================================================ server-authoritative mobs
const PASSIVE = [
  { name: 'Pig', hp: 10, speed: 2.0 },
  { name: 'Cow', hp: 12, speed: 1.8 },
  { name: 'Sheep', hp: 10, speed: 2.0 },
  { name: 'Chicken', hp: 6, speed: 2.4 },
];
const HOSTILE = [
  { name: 'Zombie', hp: 16, speed: 2.4, dmg: 3, detect: 18 },
  { name: 'Spider', hp: 12, speed: 3.4, dmg: 2, detect: 15 },
  { name: 'Creeper', hp: 14, speed: 2.6, dmg: 0, detect: 16, explode: true },
];
const MOB_LOOT = {
  Pig: [['raw_meat', 1, 2]], Cow: [['raw_meat', 1, 2]], Sheep: [['raw_meat', 1, 1]],
  Chicken: [['raw_meat', 1, 1]], Spider: [['string', 1, 2]], Zombie: [['raw_meat', 0, 1]],
  Creeper: [['coal', 0, 1]],
};
const TAU = Math.PI * 2;
const mobs = new Map();
let nextMobId = 1;
const TICK = 0.1;                 // 10 Hz simulation
const SYNC_EVERY = 2;             // broadcast positions every 2 ticks (~5 Hz)
let tickCount = 0;

function survivalPlayers() {
  return [...players.values()].filter(p => !p.teacher && p.alive !== false);
}
function nearestPlayerTo(x, z, maxD) {
  let best = null, bestD = maxD == null ? Infinity : maxD;
  for (const p of survivalPlayers()) {
    const d = Math.hypot(p.transform.x - x, p.transform.z - z);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best ? { player: best, dist: bestD } : null;
}
function spawnMob(hostile) {
  const anchor = [...players.values()].find(p => !p.teacher);
  if (!anchor) return;
  // pick dry land in an annulus around a player
  let x, z;
  for (let tries = 0; tries < 8; tries++) {
    const ang = Math.random() * TAU, r = 16 + Math.random() * 26;
    x = Math.round(anchor.transform.x + Math.cos(ang) * r);
    z = Math.round(anchor.transform.z + Math.sin(ang) * r);
    if (heightAt(x, z) > SEA) break;
  }
  if (heightAt(x, z) <= SEA) return;
  const kind = hostile ? HOSTILE[Math.floor(Math.random() * HOSTILE.length)]
                       : PASSIVE[Math.floor(Math.random() * PASSIVE.length)];
  const id = String(nextMobId++);
  mobs.set(id, {
    id, kind: kind.name, hostile, x, y: surfaceY(x, z), z, yaw: Math.random() * TAU,
    hp: kind.hp, maxhp: kind.hp, speed: kind.speed, dmg: kind.dmg || 0,
    detect: kind.detect || 0, explode: !!kind.explode,
    heading: Math.random() * TAU, wander: 1 + Math.random() * 3, moving: true,
    attackCD: 0, fuse: 0, home: { x, z }, leash: 26,
  });
}
function killMob(id, attackerId) {
  const m = mobs.get(id);
  if (!m) return;
  mobs.delete(id);
  broadcast({ type: 'mob:dead', id, x: m.x, y: m.y, z: m.z, kind: m.kind });
  if (attackerId != null) {
    const loot = (MOB_LOOT[m.kind] || []).map(([item, lo, hi]) => {
      const n = lo + Math.floor(Math.random() * (hi - lo + 1));
      return n > 0 ? [item, n] : null;
    }).filter(Boolean);
    if (loot.length) sendToId(attackerId, { type: 'loot', items: loot });
  }
}
function tickMobs() {
  const alive = survivalPlayers();
  // spawn toward a target population scaled by player count
  if (alive.length) {
    const target = Math.min(40, alive.length * 8);
    let hostileN = 0; for (const m of mobs.values()) if (m.hostile) hostileN++;
    if (mobs.size < target && Math.random() < 0.5) {
      const wantHostile = hostileN < target * 0.5;
      spawnMob(wantHostile && Math.random() < 0.7);
    }
  }
  for (const m of mobs.values()) {
    // despawn if far from every player
    if (!nearestPlayerTo(m.x, m.z, 90)) { if (Math.random() < 0.02) mobs.delete(m.id); continue; }

    let chasing = false;
    if (m.hostile && m.detect) {
      const near = nearestPlayerTo(m.x, m.z, m.detect);
      if (near) {
        chasing = true; m.moving = true;
        m.heading = Math.atan2(near.player.transform.z - m.z, near.player.transform.x - m.x);
        m.attackCD -= TICK;
        const dy = Math.abs((near.player.transform.y - 1.7) - m.y);
        if (m.explode) {
          if (near.dist < 2.4 && dy < 2.5) {
            m.moving = false; m.fuse += TICK;
            if (m.fuse > 1.1) {
              // blast: AoE damage to nearby players, then self-destruct
              for (const p of survivalPlayers()) {
                const pd = Math.hypot(p.transform.x - m.x, p.transform.z - m.z);
                if (pd < 4.5) sendToId(p.id, { type: 'hurt', dmg: Math.max(1, Math.round((1 - pd / 4.5) * 18)), fromX: m.x, fromZ: m.z });
              }
              killMob(m.id, null);
              continue;
            }
          } else m.fuse = Math.max(0, m.fuse - TICK);
        } else if (near.dist < 1.7 && dy < 2.2 && m.attackCD <= 0) {
          sendToId(near.player.id, { type: 'hurt', dmg: m.dmg, fromX: m.x, fromZ: m.z });
          m.attackCD = 0.8;
        }
      }
    }
    if (!chasing) {
      m.wander -= TICK;
      if (m.wander <= 0) { m.heading = Math.random() * TAU; m.moving = Math.random() < 0.7; m.wander = 2 + Math.random() * 4; }
    }
    if (m.moving) {
      const spd = m.speed * TICK;
      m.x += Math.cos(m.heading) * spd;
      m.z += Math.sin(m.heading) * spd;
      // leash back toward home
      const od = Math.hypot(m.x - m.home.x, m.z - m.home.z);
      if (od > m.leash) {
        const a = Math.atan2(m.z - m.home.z, m.x - m.home.x);
        m.x = m.home.x + Math.cos(a) * m.leash;
        m.z = m.home.z + Math.sin(a) * m.leash;
        m.heading += Math.PI;
      }
      m.yaw = m.heading;
    }
    m.y = surfaceY(Math.round(m.x), Math.round(m.z));   // snap to heightmap surface
  }
}
function mobSnapshot() {
  const list = [];
  for (const m of mobs.values()) {
    list.push({ id: m.id, kind: m.kind, x: +m.x.toFixed(2), y: +m.y.toFixed(2), z: +m.z.toFixed(2),
                yaw: +m.yaw.toFixed(2), hp: m.hp, max: m.maxhp, fuse: m.fuse > 0 ? 1 : 0 });
  }
  return list;
}

setInterval(() => {
  tickCount++;
  if (players.size === 0) { if (mobs.size) mobs.clear(); return; }
  tickMobs();
  if (tickCount % SYNC_EVERY === 0) broadcast({ type: 'mob:sync', mobs: mobSnapshot() });
}, TICK * 1000);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(ROOT, requested));

  if (!filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': contentTypes.get(path.extname(filePath)) || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/room' });

wss.on('connection', (ws) => {
  const id = String(nextId++);
  ws.playerId = id;
  ws.isTeacher = false;

  ws.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'join') {
      ws.isTeacher = !!message.teacher;
      const player = {
        id,
        name: ws.isTeacher ? 'Teacher' : sanitizeName(message.name),
        teacher: ws.isTeacher,
        color: String(message.color || '#66d9ef').slice(0, 16),
        transform: normalizeTransform(message.transform),
        alive: true
      };
      players.set(id, player);
      sendJson(ws, {
        type: 'room:init',
        id,
        players: [...players.values()],
        edits: [...blockEdits.entries()].map(([k, type]) => ({ key: k, type })),
        mobs: mobSnapshot()
      });
      broadcast({ type: 'player:joined', player }, ws);
      broadcast({ type: 'system', text: `${player.name} joined` }, ws);
      return;
    }

    const player = players.get(id);
    if (!player) return;

    if (message.type === 'player:update') {
      player.transform = normalizeTransform(message.transform);
      broadcast({ type: 'player:update', id, transform: player.transform }, ws);
      return;
    }

    if (message.type === 'block:set') {
      const block = normalizeBlock(message);
      if (!block) return;
      const k = `${block.x},${block.y},${block.z}`;
      blockEdits.set(k, block.type);
      broadcast({ type: 'block:set', ...block }, ws);
      return;
    }

    if (message.type === 'chat') {
      const text = String(message.text || '').slice(0, 160);
      if (!text.trim()) return;
      broadcast({ type: 'chat', id, name: player.name, color: player.color, text }, ws);
      return;
    }

    if (message.type === 'mob:attack') {
      const m = mobs.get(String(message.id));
      if (!m) return;
      const dist = Math.hypot(player.transform.x - m.x, player.transform.z - m.z);
      if (dist > 6) return;                       // basic range check
      m.hp -= Math.max(0, Math.min(50, Number(message.dmg) || 0));
      // knockback
      const dx = safeNumber(message.dx), dz = safeNumber(message.dz);
      m.x += dx * 0.5; m.z += dz * 0.5;
      if (m.hp <= 0) killMob(m.id, id);
      else broadcast({ type: 'mob:hurt', id: m.id, hp: m.hp });
      return;
    }

    if (message.type === 'pvp:attack') {
      const target = players.get(String(message.target));
      if (!target || target.teacher || target.id === id) return;
      const dist = Math.hypot(player.transform.x - target.transform.x, player.transform.z - target.transform.z);
      if (dist > 5) return;
      const dmg = Math.max(0, Math.min(20, Number(message.dmg) || 0));
      sendToId(target.id, { type: 'hurt', dmg, fromX: player.transform.x, fromZ: player.transform.z, pvp: player.name });
      return;
    }

    if (message.type === 'died') {
      player.alive = false;
      const by = message.by ? ` (${String(message.by).slice(0, 18)})` : '';
      broadcast({ type: 'system', text: `${player.name} died${by}` });
      return;
    }

    if (message.type === 'respawn') {
      player.alive = true;
      if (message.transform) player.transform = normalizeTransform(message.transform);
      return;
    }

    if (message.type === 'teacher:reset' && ws.isTeacher) {
      blockEdits.clear();
      broadcast({ type: 'world:reset' });
      sendJson(ws, { type: 'world:reset' });
      return;
    }

    if (message.type === 'teacher:teleportAll' && ws.isTeacher) {
      broadcast({ type: 'teacher:teleport', transform: normalizeTransform(message.transform) }, ws);
      return;
    }

    if (message.type === 'teacher:setMode' && ws.isTeacher) {
      const targetId = String(message.target);
      const mode = message.mode === 'creative' ? 'creative' : 'survival';
      for (const client of wss.clients) {
        if (client.playerId === targetId) sendJson(client, { type: 'mode:set', mode });
      }
    }
  });

  ws.on('close', () => {
    if (!players.has(id)) return;
    const name = players.get(id).name;
    players.delete(id);
    broadcast({ type: 'player:left', id });
    broadcast({ type: 'system', text: `${name} left` });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const urls = [];
  for (const info of Object.values(os.networkInterfaces()).flat()) {
    if (info && info.family === 'IPv4' && !info.internal) urls.push(`http://${info.address}:${PORT}/`);
  }
  console.log(`Mini Minecraft classroom server running on http://localhost:${PORT}/`);
  if (urls.length) {
    console.log('Student join URLs:');
    for (const url of urls) console.log(`  ${url}`);
    console.log(`Teacher URL: ${urls[0]}?teacher=1`);
  }
});
