import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';
import { SEA, heightAt, surfaceY, ARENA } from './shared/worldgen.js';
import { sanitizeName, safeNumber, clamp, normalizeTransform, normalizeBlock } from './shared/protocol.js';

// ============================================================ config
const CONFIG = {
  port: Number(process.env.PORT || 8099),
  tick: 0.1,            // simulation step (seconds) → 10 Hz
  syncEvery: 2,         // broadcast mob positions every N ticks (~5 Hz)
  mob: {
    perPlayer: 8,       // target population scales with player count …
    cap: 40,            // … up to this hard ceiling
    spawnChance: 0.5,   // chance per tick to add a mob while under target
    hostileShare: 0.5,  // keep at most this fraction of the target hostile
    hostileBias: 0.7,   // when spawning under the hostile target, odds it's hostile
    spawnMin: 16, spawnMax: 42,  // spawn annulus radius around a player
    despawnDist: 90,    // mobs farther than this from every player may despawn
  },
  attack: { mobRange: 6, pvpRange: 5, mobMaxDmg: 50, pvpMaxDmg: 20 },
};

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const players = new Map();
const blockEdits = new Map();
let nextId = 1;

// ============================================================ class quest
let quest = { active: false, type: '', label: '', target: 0, progress: 0 };
function questSnapshot() {
  return { active: quest.active, type: quest.type, label: quest.label, target: quest.target, progress: quest.progress };
}
function advanceQuest(n = 1) {
  if (!quest.active) return;
  quest.progress = Math.min(quest.target, quest.progress + n);
  broadcast({ type: 'quest:update', quest: questSnapshot() });
  if (quest.progress >= quest.target) {
    quest.active = false;
    broadcast({ type: 'quest:done', label: quest.label });
  }
}

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
const TICK = CONFIG.tick;
const SYNC_EVERY = CONFIG.syncEvery;
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
  const { spawnMin, spawnMax } = CONFIG.mob;
  for (let tries = 0; tries < 8; tries++) {
    const ang = Math.random() * TAU, r = spawnMin + Math.random() * (spawnMax - spawnMin);
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
  if (quest.active && quest.type === 'kill') advanceQuest(1);
  if (attackerId != null) {
    const attacker = players.get(attackerId);
    if (attacker) attacker.kills++;
    const loot = (MOB_LOOT[m.kind] || []).map(([item, lo, hi]) => {
      const n = lo + Math.floor(Math.random() * (hi - lo + 1));
      return n > 0 ? [item, n] : null;
    }).filter(Boolean);
    if (loot.length) sendToId(attackerId, { type: 'loot', items: loot });
  }
  if (m.arenaBoss) broadcast({ type: 'system', text: '🏆 The Arena Dragon has been defeated!' });
  if (m.colossus) broadcast({ type: 'system', text: '🏆 The Magma Colossus has been destroyed!' });
}
// arena boss phases: ranged fireball when out of melee range, and minion
// summons once it drops below half health. `near` is the nearest in-range
// player, already computed by the caller.
function tickArenaBoss(m, near) {
  m.fireCD -= TICK;
  m.summonCD -= TICK;
  if (near.dist > 3 && m.fireCD <= 0) {
    m.fireCD = 3.2;
    const tx = near.player.transform.x, ty = near.player.transform.y, tz = near.player.transform.z;
    broadcast({ type: 'boss:fireball', id: m.id, x: m.x, y: m.y + 1.6, z: m.z, tx, ty, tz });
    const travel = Math.max(0.4, Math.hypot(tx - m.x, tz - m.z) / 26);
    setTimeout(() => {
      for (const p of survivalPlayers()) {
        const d = Math.hypot(p.transform.x - tx, p.transform.z - tz);
        if (d < 3) {
          sendToId(p.id, { type: 'hurt', dmg: Math.max(2, Math.round((1 - d / 3) * 12)), fromX: tx, fromZ: tz });
          broadcast({ type: 'player:hurt', id: p.id });
        }
      }
    }, travel * 1000);
  }
  if (m.hp <= m.maxhp * 0.5 && m.summonCD <= 0) {
    let active = 0;
    for (const mm of mobs.values()) if (mm.summonedBy === m.id) active++;
    if (active < 3) {
      m.summonCD = 18;
      for (let i = 0; i < 2; i++) {
        const ang = Math.random() * TAU, r = 3 + Math.random() * 4;
        const sx = m.x + Math.cos(ang) * r, sz = m.z + Math.sin(ang) * r;
        const sid = String(nextMobId++);
        mobs.set(sid, {
          id: sid, kind: 'Zombie', hostile: true, summonedBy: m.id,
          x: sx, y: surfaceY(Math.round(sx), Math.round(sz)), z: sz, yaw: 0,
          hp: 16, maxhp: 16, speed: 2.6, dmg: 3, detect: 18, explode: false,
          heading: 0, wander: 2, moving: true, attackCD: 0, fuse: 0,
          home: { x: sx, z: sz }, leash: ARENA.radius + 4,
        });
      }
      broadcast({ type: 'system', text: '⚠ The Dragon summons minions!' });
    }
  }
}
// ---- Magma Colossus: a dedicated arena boss that fights as a state machine
// (pursue → telegraph → strike → rest) with three telegraphed attacks and a
// vulnerable "rest" window. Arena-only; spawned by the teacher panel.
const COLOSSUS = {
  hp: 750, speed: 3.2, dmg: 10,
  slamRange: 7,        // engage with a slam when a player is this close
  slamRadius: 7.5, slamDmg: 18,
  meteorRadius: 3.2, meteorDmg: 15, meteorCount: 3,
  windDur: 1.4,        // telegraph time before a strike lands
  restDur: 3.4,        // vulnerable window after a strike
  pursueMin: 1.6,      // minimum chase time between attacks
  armorMult: 0.3,      // damage taken while not resting (armored)
  vulnMult: 2.0,       // damage taken during the rest window
};
function bossFireballAt(m, tx, ty, tz) {
  broadcast({ type: 'boss:fireball', id: m.id, x: m.x, y: m.y + 2.6, z: m.z, tx, ty, tz });
  const travel = Math.max(0.4, Math.hypot(tx - m.x, tz - m.z) / 26);
  setTimeout(() => {
    for (const p of survivalPlayers()) {
      const d = Math.hypot(p.transform.x - tx, p.transform.z - tz);
      if (d < 3) {
        sendToId(p.id, { type: 'hurt', dmg: Math.max(2, Math.round((1 - d / 3) * 12)), fromX: tx, fromZ: tz });
        broadcast({ type: 'player:hurt', id: p.id });
      }
    }
  }, travel * 1000);
}
function startColossusAttack(m, near) {
  const enraged = m.hp <= m.maxhp * 0.4;
  const attack = near.dist <= COLOSSUS.slamRange ? 'slam' : (Math.random() < 0.5 ? 'meteor' : 'fireball');
  m.attack = attack; m.phase = 'wind'; m.bossState = 'wind'; m.moving = false;
  m.phaseT = enraged ? COLOSSUS.windDur * 0.7 : COLOSSUS.windDur;
  if (attack === 'slam') {
    broadcast({ type: 'boss:telegraph', id: m.id, dur: m.phaseT, color: 0xff2a1a,
      spots: [{ x: +m.x.toFixed(2), z: +m.z.toFixed(2), r: COLOSSUS.slamRadius }] });
  } else if (attack === 'meteor') {
    const ps = survivalPlayers().slice(0, enraged ? COLOSSUS.meteorCount + 1 : COLOSSUS.meteorCount);
    m.meteorSpots = ps.length
      ? ps.map(p => ({ x: p.transform.x, z: p.transform.z, r: COLOSSUS.meteorRadius }))
      : [{ x: m.x, z: m.z, r: COLOSSUS.meteorRadius }];
    broadcast({ type: 'boss:telegraph', id: m.id, dur: m.phaseT, color: 0xffa01a,
      spots: m.meteorSpots.map(s => ({ x: +s.x.toFixed(2), z: +s.z.toFixed(2), r: s.r })) });
  } else { // fireball: lock the target now, fire on strike (no ground telegraph — the body wind-up is the tell)
    m.fbTarget = { x: near.player.transform.x, y: near.player.transform.y, z: near.player.transform.z };
  }
}
function strikeColossus(m) {
  if (m.attack === 'slam') {
    for (const p of survivalPlayers()) {
      const d = Math.hypot(p.transform.x - m.x, p.transform.z - m.z);
      if (d < COLOSSUS.slamRadius) {
        sendToId(p.id, { type: 'hurt', dmg: Math.max(3, Math.round((1 - d / COLOSSUS.slamRadius) * COLOSSUS.slamDmg)), fromX: m.x, fromZ: m.z });
        broadcast({ type: 'player:hurt', id: p.id });
      }
    }
  } else if (m.attack === 'meteor') {
    for (const s of (m.meteorSpots || [])) {
      for (const p of survivalPlayers()) {
        const d = Math.hypot(p.transform.x - s.x, p.transform.z - s.z);
        if (d < s.r) {
          sendToId(p.id, { type: 'hurt', dmg: Math.max(3, Math.round((1 - d / s.r) * COLOSSUS.meteorDmg)), fromX: s.x, fromZ: s.z });
          broadcast({ type: 'player:hurt', id: p.id });
        }
      }
    }
  } else if (m.attack === 'fireball' && m.fbTarget) {
    const t = m.fbTarget, n = m.hp <= m.maxhp * 0.4 ? 5 : 3;
    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * 1.6;
      bossFireballAt(m, t.x + off, t.y, t.z + off * 0.3);
    }
  }
}
function tickColossus(m, near) {
  m.phaseT -= TICK;
  if (m.phase === 'wind') {
    m.moving = false;
    if (m.phaseT <= 0) {
      strikeColossus(m);
      m.phase = 'rest'; m.bossState = 'rest'; m.vulnerable = true;
      m.phaseT = m.hp <= m.maxhp * 0.4 ? COLOSSUS.restDur * 0.75 : COLOSSUS.restDur;
    }
  } else if (m.phase === 'rest') {
    m.moving = false;
    if (m.phaseT <= 0) { m.phase = 'pursue'; m.bossState = 'pursue'; m.vulnerable = false; m.phaseT = COLOSSUS.pursueMin; }
  } else { // pursue — heading toward the player is already set by the caller
    m.moving = true;
    if (m.phaseT <= 0) startColossusAttack(m, near);
  }
}
function tickMobs() {
  const alive = survivalPlayers();
  // spawn toward a target population scaled by player count
  if (alive.length) {
    const mc = CONFIG.mob;
    const target = Math.min(mc.cap, alive.length * mc.perPlayer);
    let hostileN = 0; for (const m of mobs.values()) if (m.hostile) hostileN++;
    if (mobs.size < target && Math.random() < mc.spawnChance) {
      const wantHostile = hostileN < target * mc.hostileShare;
      spawnMob(wantHostile && Math.random() < mc.hostileBias);
    }
  }
  for (const m of mobs.values()) {
    // despawn if far from every player — but never despawn a summoned boss
    if (!nearestPlayerTo(m.x, m.z, CONFIG.mob.despawnDist)) {
      if (!m.colossus && !m.arenaBoss && Math.random() < 0.02) mobs.delete(m.id);
      continue;
    }

    let chasing = false;
    if (m.hostile && m.detect) {
      const near = nearestPlayerTo(m.x, m.z, m.detect);
      if (near) {
        chasing = true; m.moving = true;
        m.heading = Math.atan2(near.player.transform.z - m.z, near.player.transform.x - m.x);
        if (m.colossus) { tickColossus(m, near); } else {
        m.attackCD -= TICK;
        const dy = Math.abs((near.player.transform.y - 1.7) - m.y);
        if (m.explode) {
          if (near.dist < 2.4 && dy < 2.5) {
            m.moving = false; m.fuse += TICK;
            if (m.fuse > 1.1) {
              // blast: AoE damage to nearby players, then self-destruct
              for (const p of survivalPlayers()) {
                const pd = Math.hypot(p.transform.x - m.x, p.transform.z - m.z);
                if (pd < 4.5) {
                  sendToId(p.id, { type: 'hurt', dmg: Math.max(1, Math.round((1 - pd / 4.5) * 18)), fromX: m.x, fromZ: m.z });
                  broadcast({ type: 'player:hurt', id: p.id });
                }
              }
              killMob(m.id, null);
              continue;
            }
          } else m.fuse = Math.max(0, m.fuse - TICK);
        } else if (near.dist < 1.7 && dy < 2.2 && m.attackCD <= 0) {
          sendToId(near.player.id, { type: 'hurt', dmg: m.dmg, fromX: m.x, fromZ: m.z });
          broadcast({ type: 'player:hurt', id: near.player.id });
          m.attackCD = 0.8;
        }
        if (m.arenaBoss) tickArenaBoss(m, near);
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
function leaderboardSnapshot() {
  return [...players.values()]
    .filter(p => !p.teacher)
    .map(p => ({ id: p.id, name: p.name, kills: p.kills, blocksPlaced: p.blocksPlaced, quest: p.questContrib }));
}
function mobSnapshot() {
  const list = [];
  for (const m of mobs.values()) {
    list.push({ id: m.id, kind: m.kind, x: +m.x.toFixed(2), y: +m.y.toFixed(2), z: +m.z.toFixed(2),
                yaw: +m.yaw.toFixed(2), hp: m.hp, max: m.maxhp, fuse: m.fuse > 0 ? 1 : 0,
                st: m.colossus ? m.bossState : undefined });
  }
  return list;
}

setInterval(() => {
  tickCount++;
  if (players.size === 0) { if (mobs.size) mobs.clear(); return; }
  tickMobs();
  if (tickCount % SYNC_EVERY === 0) broadcast({ type: 'mob:sync', mobs: mobSnapshot() });
  if (tickCount % 20 === 0) broadcast({ type: 'leaderboard:update', players: leaderboardSnapshot() });
}, TICK * 1000);

// ============================================================ websocket message handlers
// Map of message type -> handler(ws, message, player). `player` is null only for
// 'join' (which creates it); every other handler is dispatched after the
// connection's player record is confirmed to exist.
const messageHandlers = {
  join(ws, message) {
    // only one teacher (admin) allowed: a second ?teacher join joins as a student
    const teacherTaken = [...players.values()].some(p => p.teacher);
    ws.isTeacher = !!message.teacher && !teacherTaken;
    const player = {
      id: ws.playerId,
      name: ws.isTeacher ? 'Teacher' : sanitizeName(message.name),
      teacher: ws.isTeacher,
      color: String(message.color || '#66d9ef').slice(0, 16),
      transform: normalizeTransform(message.transform),
      alive: true,
      kills: 0, blocksPlaced: 0, questContrib: 0,
    };
    players.set(ws.playerId, player);
    sendJson(ws, {
      type: 'room:init',
      id: ws.playerId,
      teacher: ws.isTeacher,   // authoritative: client demotes itself if denied
      players: [...players.values()],
      edits: [...blockEdits.entries()].map(([k, type]) => ({ key: k, type })),
      mobs: mobSnapshot(),
      quest: questSnapshot(),
      leaderboard: leaderboardSnapshot(),
    });
    broadcast({ type: 'player:joined', player }, ws);
    broadcast({ type: 'system', text: `${player.name} joined` }, ws);
  },

  'player:update'(ws, message, player) {
    player.transform = normalizeTransform(message.transform);
    broadcast({ type: 'player:update', id: ws.playerId, transform: player.transform }, ws);
  },

  'block:set'(ws, message, player) {
    const block = normalizeBlock(message);
    if (!block) return;
    const k = `${block.x},${block.y},${block.z}`;
    blockEdits.set(k, block.type);
    if (block.type) player.blocksPlaced++;
    broadcast({ type: 'block:set', ...block }, ws);
  },

  chat(ws, message, player) {
    const text = String(message.text || '').slice(0, 160);
    if (!text.trim()) return;
    broadcast({ type: 'chat', id: ws.playerId, name: player.name, color: player.color, text }, ws);
  },

  'mob:attack'(ws, message, player) {
    const m = mobs.get(String(message.id));
    if (!m) return;
    const dist = Math.hypot(player.transform.x - m.x, player.transform.z - m.z);
    if (dist > CONFIG.attack.mobRange) return;
    let dmg = Math.max(0, Math.min(CONFIG.attack.mobMaxDmg, Number(message.dmg) || 0));
    if (m.colossus) dmg *= m.vulnerable ? COLOSSUS.vulnMult : COLOSSUS.armorMult;
    m.hp -= dmg;
    const dx = safeNumber(message.dx), dz = safeNumber(message.dz);   // knockback
    m.x += dx * 0.5; m.z += dz * 0.5;
    if (m.hp <= 0) killMob(m.id, ws.playerId);
    else broadcast({ type: 'mob:hurt', id: m.id, hp: m.hp });
  },

  // a player used a spawn egg → create a server-authoritative mob everyone sees
  'mob:spawn'(ws, message) {
    if (mobs.size >= CONFIG.mob.cap + 20) return;   // flood guard
    const kind = String(message.kind || '').slice(0, 24);
    if (!kind) return;
    const x = safeNumber(message.x), z = safeNumber(message.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const hp = clamp(Number(message.hp) || 10, 1, 200);
    const id = String(nextMobId++);
    mobs.set(id, {
      id, kind, hostile: !!message.hostile,
      x, y: surfaceY(Math.round(x), Math.round(z)), z, yaw: Math.random() * TAU,
      hp, maxhp: hp,
      speed: clamp(Number(message.speed) || 2, 0, 8),
      dmg: clamp(Number(message.dmg) || 0, 0, 10),
      detect: clamp(Number(message.detect) || 0, 0, 48),
      explode: !!message.explode,
      heading: Math.random() * TAU, wander: 1 + Math.random() * 3, moving: true,
      attackCD: 0, fuse: 0, home: { x, z }, leash: 26,
    });
    broadcast({ type: 'mob:sync', mobs: mobSnapshot() });
  },

  'pvp:attack'(ws, message, player) {
    const target = players.get(String(message.target));
    if (!target || target.teacher || target.id === ws.playerId) return;
    const dist = Math.hypot(player.transform.x - target.transform.x, player.transform.z - target.transform.z);
    if (dist > CONFIG.attack.pvpRange) return;
    const dmg = Math.max(0, Math.min(CONFIG.attack.pvpMaxDmg, Number(message.dmg) || 0));
    sendToId(target.id, { type: 'hurt', dmg, fromX: player.transform.x, fromZ: player.transform.z, pvp: player.name });
    broadcast({ type: 'player:hurt', id: target.id });
  },

  died(ws, message, player) {
    player.alive = false;
    const by = message.by ? ` (${String(message.by).slice(0, 18)})` : '';
    broadcast({ type: 'system', text: `${player.name} died${by}` });
  },

  respawn(ws, message, player) {
    player.alive = true;
    if (message.transform) player.transform = normalizeTransform(message.transform);
  },

  'teacher:reset'(ws) {
    if (!ws.isTeacher) return;
    blockEdits.clear();
    broadcast({ type: 'world:reset' });
    sendJson(ws, { type: 'world:reset' });
  },

  'teacher:setQuest'(ws, message) {
    if (!ws.isTeacher) return;
    const type = ['mine', 'build', 'kill'].includes(message.qtype) ? message.qtype : 'mine';
    const target = Math.max(1, Math.min(9999, Number(message.target) || 10));
    const label = String(message.label || '').slice(0, 48) || `${type} ${target}`;
    quest = { active: true, type, label, target, progress: 0 };
    broadcast({ type: 'quest:update', quest: questSnapshot() });
    broadcast({ type: 'system', text: `Class quest: ${label}` });
  },

  'teacher:clearQuest'(ws) {
    if (!ws.isTeacher) return;
    quest = { active: false, type: '', label: '', target: 0, progress: 0 };
    broadcast({ type: 'quest:update', quest: questSnapshot() });
  },

  'teacher:spawnBoss'(ws) {
    if (!ws.isTeacher) return;
    const t = players.get(ws.playerId);
    const bx = t ? t.transform.x + 5 : 0;
    const bz = t ? t.transform.z : 0;
    const id = String(nextMobId++);
    mobs.set(id, {
      id, kind: 'Dragon', hostile: true,
      x: bx, y: surfaceY(Math.round(bx), Math.round(bz)), z: bz, yaw: 0,
      hp: 400, maxhp: 400, speed: 4.5, dmg: 8, detect: 44,
      explode: false, heading: 0, wander: 2, moving: true,
      attackCD: 0, fuse: 0, home: { x: bx, z: bz }, leash: 80,
    });
    broadcast({ type: 'mob:sync', mobs: mobSnapshot() });
    broadcast({ type: 'system', text: '⚠ A BOSS has appeared! Defeat it together!' });
  },

  'teacher:spawnArenaBoss'(ws) {
    if (!ws.isTeacher) return;
    for (const [id, m] of mobs) if (m.arenaBoss) mobs.delete(id);   // only one at a time
    const id = String(nextMobId++);
    mobs.set(id, {
      id, kind: 'Dragon', hostile: true, arenaBoss: true,
      x: ARENA.x, y: ARENA.floorY + 1, z: ARENA.z, yaw: 0,
      hp: 600, maxhp: 600, speed: 4.0, dmg: 9, detect: ARENA.radius + 6,
      explode: false, heading: 0, wander: 2, moving: true,
      attackCD: 0, fuse: 0, home: { x: ARENA.x, z: ARENA.z }, leash: ARENA.radius + 2,
      fireCD: 3, summonCD: 12,
    });
    broadcast({ type: 'mob:sync', mobs: mobSnapshot() });
    broadcast({ type: 'system', text: '⚔ The Arena Dragon awakens!' });
  },

  'teacher:spawnArenaColossus'(ws) {
    if (!ws.isTeacher) return;
    for (const [id, m] of mobs) if (m.colossus) mobs.delete(id);   // only one at a time
    const id = String(nextMobId++);
    mobs.set(id, {
      id, kind: 'Colossus', hostile: true, colossus: true,
      x: ARENA.x, y: ARENA.floorY + 1, z: ARENA.z, yaw: 0,
      hp: COLOSSUS.hp, maxhp: COLOSSUS.hp, speed: COLOSSUS.speed, dmg: COLOSSUS.dmg,
      detect: ARENA.radius + 10, explode: false,
      heading: 0, wander: 2, moving: true, attackCD: 0, fuse: 0,
      home: { x: ARENA.x, z: ARENA.z }, leash: ARENA.radius - 1,
      phase: 'pursue', phaseT: COLOSSUS.pursueMin, bossState: 'pursue', vulnerable: false, meteorSpots: [],
    });
    broadcast({ type: 'mob:sync', mobs: mobSnapshot() });
    broadcast({ type: 'system', text: '🌋 The MAGMA COLOSSUS rises! Strike it only when it rests!' });
  },

  'quest:progress'(ws, message, player) {
    if (!quest.active) return;
    if (String(message.qtype) !== quest.type) return;
    const n = Math.max(1, Math.min(64, Number(message.n) || 1));
    advanceQuest(n);
    player.questContrib += n;
  },

  'item:gift'(ws, message, player) {
    const target = players.get(String(message.target));
    if (!target || target.id === ws.playerId || target.teacher) return;
    const dist = Math.hypot(player.transform.x - target.transform.x, player.transform.z - target.transform.z);
    if (dist > 8) return;
    const item = String(message.item || '').slice(0, 32);
    const count = Math.max(1, Math.min(64, Number(message.count) || 1));
    if (!item) return;
    sendToId(target.id, { type: 'item:received', from: player.name, item, count });
    broadcast({ type: 'system', text: `${player.name} gave ${count}x ${item} to ${target.name}` });
  },

  'teacher:teleportAll'(ws, message) {
    if (!ws.isTeacher) return;
    broadcast({ type: 'teacher:teleport', transform: normalizeTransform(message.transform) }, ws);
  },

  'teacher:setMode'(ws, message) {
    if (!ws.isTeacher) return;
    const targetId = String(message.target);
    const mode = message.mode === 'creative' ? 'creative' : 'survival';
    for (const client of wss.clients) {
      if (client.playerId === targetId) sendJson(client, { type: 'mode:set', mode });
    }
  },
};

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

    const handler = messageHandlers[message.type];
    if (!handler) return;
    if (message.type === 'join') { handler(ws, message, null); return; }

    const player = players.get(id);
    if (!player) return;
    handler(ws, message, player);
  });

  ws.on('close', () => {
    if (!players.has(id)) return;
    const name = players.get(id).name;
    players.delete(id);
    broadcast({ type: 'player:left', id });
    broadcast({ type: 'system', text: `${name} left` });
  });
});

server.listen(CONFIG.port, '0.0.0.0', () => {
  const urls = [];
  for (const info of Object.values(os.networkInterfaces()).flat()) {
    if (info && info.family === 'IPv4' && !info.internal) urls.push(`http://${info.address}:${CONFIG.port}/`);
  }
  console.log(`Mini Minecraft classroom server running on http://localhost:${CONFIG.port}/`);
  if (urls.length) {
    console.log('Same-Wi-Fi student join URLs:');
    for (const url of urls) console.log(`  ${url}`);
    console.log(`Teacher URL: ${urls[0]}?teacher=1`);
  }
  console.log('If apartment Wi-Fi blocks port forwarding, run `npm run share` for a public tunnel URL.');
});
