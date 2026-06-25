import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName, safeNumber, clamp, normalizeTransform, normalizeBlock, WORLD } from '../shared/protocol.js';

// Validation guards the websocket boundary so a malformed or out-of-range
// payload can't silently corrupt server state.

test('sanitizeName strips junk, trims, caps length, and never returns empty', () => {
  assert.equal(sanitizeName('  Alice  '), 'Alice');
  assert.equal(sanitizeName('<script>'), 'script');
  assert.equal(sanitizeName(''), 'Student');
  assert.equal(sanitizeName(null), 'Student');
  assert.equal(sanitizeName('x'.repeat(50)).length, 18);
});

test('safeNumber rejects non-finite values', () => {
  assert.equal(safeNumber(3.5), 3.5);
  assert.equal(safeNumber(NaN), 0);
  assert.equal(safeNumber(Infinity), 0);
  assert.equal(safeNumber('nope', 9), 9);
});

test('clamp bounds values and rejects non-finite input', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
  assert.equal(clamp(NaN, 0, 10), 0);
});

test('normalizeTransform coerces every field to a finite number', () => {
  const t = normalizeTransform({ x: 1, y: 'bad', z: NaN, yaw: 2 });
  assert.deepEqual(t, { x: 1, y: 0, z: 0, yaw: 2, pitch: 0 });
  assert.deepEqual(normalizeTransform(null), { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
});

test('normalizeBlock truncates coordinates and clamps the type string', () => {
  assert.deepEqual(normalizeBlock({ x: 3.9, y: -2.1, z: 7, type: 'stone' }), { x: 3, y: -2, z: 7, type: 'stone' });
  assert.deepEqual(normalizeBlock({ x: 1, y: 1, z: 1, type: null }).type, null);
  assert.equal(normalizeBlock({ x: 0, y: 0, z: 0, type: 'a'.repeat(80) }).type.length, 40);
});

test('normalizeBlock rejects non-finite and out-of-range coordinates', () => {
  assert.equal(normalizeBlock({ x: NaN, y: 0, z: 0 }), null);
  assert.equal(normalizeBlock({ x: 0, y: Infinity, z: 0 }), null);
  assert.equal(normalizeBlock({ x: WORLD.maxXZ + 1, y: 0, z: 0 }), null);
  assert.equal(normalizeBlock({ x: 0, y: WORLD.maxY + 1, z: 0 }), null);
  assert.equal(normalizeBlock({ x: 0, y: WORLD.minY - 1, z: 0 }), null);
});
