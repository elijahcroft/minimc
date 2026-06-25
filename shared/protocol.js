// Validation/normalization for websocket payloads, shared so the rules live in
// one place and can be unit-tested. Every helper is total: it always returns a
// safe value (or null for "reject this message") and never throws on malformed
// or out-of-range input.

// Generous world bounds — wide enough for legitimate play (sky planets sit
// around y≈200) but tight enough that a malformed/hostile payload can't push a
// block edit to an absurd coordinate and bloat server state.
export const WORLD = { maxXZ: 1_000_000, minY: -256, maxY: 4096 };

export function safeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

export function clamp(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

export function sanitizeName(value) {
  const clean = String(value || '')
    .replace(/[^\w .-]/g, '')
    .trim()
    .slice(0, 18);
  return clean || 'Student';
}

export function normalizeTransform(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    x: safeNumber(v.x),
    y: safeNumber(v.y),
    z: safeNumber(v.z),
    yaw: safeNumber(v.yaw),
    pitch: safeNumber(v.pitch),
  };
}

// Returns a clean {x,y,z,type} or null if the coordinates are non-finite or out
// of world bounds. type is null (air/removal) or a short string id.
export function normalizeBlock(message) {
  const x = Math.trunc(Number(message.x));
  const y = Math.trunc(Number(message.y));
  const z = Math.trunc(Number(message.z));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  if (Math.abs(x) > WORLD.maxXZ || Math.abs(z) > WORLD.maxXZ) return null;
  if (y < WORLD.minY || y > WORLD.maxY) return null;
  const type = message.type == null ? null : String(message.type).slice(0, 40);
  return { x, y, z, type };
}
