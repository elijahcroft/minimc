import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEA, heightAt, surfaceY, isDesert, smooth2, rand } from '../shared/worldgen.js';

// These tests pin the deterministic terrain math that BOTH the client and the
// server import. If they fail after an edit, the two sides would generate
// different worlds — the classic multiplayer-desync bug this module exists to
// prevent.

test('rand and smooth2 are pure functions of their inputs', () => {
  assert.equal(rand(3, 7), rand(3, 7));
  assert.equal(smooth2(12.5, -4.25), smooth2(12.5, -4.25));
});

test('heightAt is deterministic and returns whole-block heights', () => {
  for (const [x, z] of [
    [0, 0],
    [10, 10],
    [-5, 12],
    [100, -40],
    [37, 128],
  ]) {
    const h = heightAt(x, z);
    assert.equal(h, heightAt(x, z), `heightAt(${x},${z}) must be stable`);
    assert.ok(Number.isInteger(h), `heightAt(${x},${z}) must be an integer`);
  }
});

test('surfaceY is always one block above the terrain height', () => {
  for (const [x, z] of [
    [0, 0],
    [10, 10],
    [-5, 12],
    [100, -40],
  ]) {
    assert.equal(surfaceY(x, z), heightAt(x, z) + 1);
  }
});

test('regression snapshot of known terrain heights', () => {
  // Hardcoded outputs captured from the reference implementation. A change here
  // means terrain generation shifted — intentional only if both sides update.
  assert.equal(SEA, 7);
  assert.equal(heightAt(0, 0), 6);
  assert.equal(heightAt(10, 10), 10);
  assert.equal(heightAt(-5, 12), 13);
  assert.equal(heightAt(100, -40), 8);
  assert.equal(heightAt(37, 128), 15);
});

test('isDesert returns a stable boolean', () => {
  const d = isDesert(500, 500);
  assert.equal(typeof d, 'boolean');
  assert.equal(d, isDesert(500, 500));
});
