import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeToy, encodeToy, validateToy, saveToy, listToys, MAX_TOY_BYTES } from '../src/storage/index.js';
import { soundKey } from '../src/core/music.js';

const a = { pitches: [60], duration: { n: 1, d: 1 }, labels: ['C4'] };
const b = { pitches: [64, 67], duration: { n: 3, d: 2 }, labels: ['E4', 'G4'] };
const rest = { pitches: [], duration: { n: 1, d: 1 }, labels: [] };

function toy() {
  return {
    version: 1, name: 'A small constellation', savedAt: '2026-10-25T20:00:00.000Z',
    source: { name: 'My source', events: [a, b, a, rest, a, b], warnings: ['One tempo is used.'] },
    seed: 'summer-2026', overrides: { [soundKey(a)]: { [soundKey(b)]: 2.5 } },
    controls: { tempo: 96, preset: 'warm', temperature: 1, volume: 0.6, freezeCount: 16 },
    clip: { events: [{ stateId: soundKey(a), sound: a }, { stateId: soundKey(b), sound: b }] },
  };
}

test('portable JSON retains source, controls, seed, edits, and frozen phrase independently', () => {
  const original = toy();
  const restored = decodeToy(encodeToy(original));
  assert.deepEqual(JSON.parse(JSON.stringify(restored)), original);
  restored.source.events[0].pitches[0] = 2;
  restored.controls.tempo = 140;
  assert.equal(original.source.events[0].pitches[0], 60);
  assert.equal(original.controls.tempo, 96);
  assert.equal(Object.hasOwn(restored, 'playing'), false);
});

test('canonicalizes exact rational durations and sorted pitch sets', () => {
  const original = toy();
  original.source.events = [{ pitches: [67, 60, 67], duration: { n: 6, d: 4 }, labels: ['G4', 'C4', 'G4'] }];
  original.overrides = {};
  original.clip = null;
  const restored = validateToy(original);
  assert.deepEqual(restored.source.events[0], { pitches: [60, 67], duration: { n: 3, d: 2 }, labels: ['C4', 'G4'] });
});

test('accepts a one-sound source and a frozen artificial boundary rest', () => {
  const original = toy();
  original.source.events = [b];
  original.overrides = { [soundKey(b)]: { [soundKey(rest)]: 1 } };
  original.clip = { events: [{ stateId: soundKey(rest), sound: rest }] };
  assert.equal(decodeToy(encodeToy(original)).clip.events.length, 1);
});

test('rejects malformed, oversized, and unsupported future saved toys', () => {
  assert.throws(() => decodeToy('{oops'), /not valid JSON/);
  assert.throws(() => decodeToy(' '.repeat(MAX_TOY_BYTES + 1)), /exceeds 5 MiB/);
  assert.throws(() => decodeToy(JSON.stringify({ ...toy(), version: 2 })), /version 2 is unsupported/);
  assert.throws(() => validateToy([]), /must be an object/);
  assert.throws(() => validateToy({ ...toy(), source: { ...toy().source, events: [] } }), /1 to 4,096/);
  assert.throws(() => validateToy({ ...toy(), source: { ...toy().source, events: Array(4097).fill(a) } }), /4,096/);
  assert.throws(() => validateToy({ ...toy(), clip: { events: Array(33).fill({ stateId: soundKey(a), sound: a }) } }), /1 to 32/);
});

test('counts synthetic closing rest toward the state limit', () => {
  const original = toy();
  original.source.events = Array.from({ length: 512 }, (_, i) => ({ pitches: [60], duration: { n: i + 1, d: 1 }, labels: ['C4'] }));
  original.overrides = {};
  original.clip = null;
  assert.throws(() => validateToy(original), /512 states/);
  original.source.events.pop();
  assert.equal(validateToy(original).source.events.length, 511);
});

test('rejects invalid controls and sound values without silently clamping', () => {
  for (const [field, bad] of [['tempo', 0], ['tempo', 241], ['temperature', 3], ['volume', 1.1], ['preset', 'unknown'], ['freezeCount', 12]]) {
    const original = toy();
    original.controls[field] = bad;
    assert.throws(() => validateToy(original), /Cannot open this toy/);
  }
  for (const invalid of [
    { pitches: [60.5], duration: { n: 1, d: 1 }, labels: [] },
    { pitches: [128], duration: { n: 1, d: 1 }, labels: [] },
    { pitches: [60], duration: { n: 0, d: 1 }, labels: [] },
    { pitches: [60], duration: { n: 1, d: 0 }, labels: [] },
    { pitches: [60], duration: { n: 1, d: 1 }, labels: [null] },
  ]) {
    assert.throws(() => validateToy({ ...toy(), source: { ...toy().source, events: [invalid] } }), /Cannot open this toy/);
  }
});

test('rejects unknown states and edges, unusable rows, and prototype pollution keys', () => {
  const original = toy();
  original.overrides = { [soundKey(a)]: { [soundKey(a)]: 1 } };
  assert.throws(() => validateToy(original), /connection absent/);
  original.overrides = { [soundKey(a)]: { [soundKey(b)]: 0, [soundKey(rest)]: 0 } };
  assert.throws(() => validateToy(original), /positive outgoing/);
  original.overrides = { [soundKey(a)]: { [soundKey(b)]: -1 } };
  assert.throws(() => validateToy(original), /connection weight/);
  original.overrides = { [soundKey(a)]: { [soundKey(b)]: 1_000_001 } };
  assert.throws(() => validateToy(original), /connection weight/);
  original.overrides = JSON.parse('{"__proto__":{"polluted":1}}');
  assert.throws(() => validateToy(original), /unknown source state/);
  assert.equal({}.polluted, undefined);
});

test('checks frozen state identity and source membership', () => {
  const original = toy();
  original.clip.events[0] = { stateId: soundKey(b), sound: a };
  assert.throws(() => validateToy(original), /does not match a state/);
  const unknown = { pitches: [20], duration: { n: 1, d: 1 }, labels: [] };
  original.clip.events[0] = { stateId: soundKey(unknown), sound: unknown };
  assert.throws(() => validateToy(original), /does not match a state/);
});

test('library reports a usable fallback when IndexedDB is unavailable', async () => {
  await assert.rejects(listToys(), /portable JSON/);
  await assert.rejects(saveToy(toy()), /portable JSON/);
});
