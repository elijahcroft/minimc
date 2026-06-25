// Deterministic terrain generation shared by the client (rendering) and the
// server (mob spawning / surface snapping). Keeping a single source of truth
// here prevents the two sides from silently drifting and corrupting multiplayer
// state. Pure math only — no DOM, no three.js, no Node APIs — so it loads
// unchanged as an ES module in the browser and in Node.

export const SEA = 7;

export function rand(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function smooth2(x, z) {
  const xi = Math.floor(x),
    zi = Math.floor(z),
    xf = x - xi,
    zf = z - zi;
  const u = xf * xf * (3 - 2 * xf),
    v = zf * zf * (3 - 2 * zf);
  const a = rand(xi, zi),
    b = rand(xi + 1, zi),
    c = rand(xi, zi + 1),
    d = rand(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function rand3(x, y, z) {
  const s = Math.sin(x * 12.9 + y * 78.2 + z * 37.7) * 43758.5;
  return s - Math.floor(s);
}

export function smooth3(x, y, z) {
  const xi = Math.floor(x),
    yi = Math.floor(y),
    zi = Math.floor(z);
  const xf = x - xi,
    yf = y - yi,
    zf = z - zi;
  const u = xf * xf * (3 - 2 * xf),
    v = yf * yf * (3 - 2 * yf),
    w = zf * zf * (3 - 2 * zf);
  const L = (a, b, t) => a + (b - a) * t;
  return L(
    L(L(rand3(xi, yi, zi), rand3(xi + 1, yi, zi), u), L(rand3(xi, yi + 1, zi), rand3(xi + 1, yi + 1, zi), u), v),
    L(
      L(rand3(xi, yi, zi + 1), rand3(xi + 1, yi, zi + 1), u),
      L(rand3(xi, yi + 1, zi + 1), rand3(xi + 1, yi + 1, zi + 1), u),
      v
    ),
    w
  );
}

// low-frequency biome field: >0.55 → desert (sand, low rolling hills), else plains/grass
export function biomeAt(x, z) {
  return smooth2(x / 140 + 50, z / 140 + 50);
}
export function isDesert(x, z) {
  return biomeAt(x, z) > 0.55;
}

export function heightAt(x, z) {
  const n = smooth2(x / 22, z / 22) * 1.0 + smooth2(x / 9, z / 9) * 0.35;
  const amp = isDesert(x, z) ? 9 : 16; // deserts: lower, gentler rolling hills
  return Math.floor(6 + (n / 1.35) * amp);
}

export function surfaceY(x, z) {
  return heightAt(x, z) + 1;
}
