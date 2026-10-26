import test from 'node:test';
import assert from 'node:assert/strict';
import { fraction, add, sub, compare, toBeats, makeSound, soundKey, soundName, durationName } from '../src/core/music.js';
import { train, distribution, sample, seededRandom, createWalker, validateOverrides } from '../src/core/model.js';
import { examples } from '../src/core/examples.js';

const a = makeSound([60], fraction(1), ['C4']);
const b = makeSound([64], fraction(1), ['E4']);
const c = makeSound([67], fraction(1), ['G4']);
const rest = makeSound([], fraction(1));
const ids = [a, b, c, rest].map(soundKey);
const [A, B, C, R] = ids;
const asymmetric = () => train([a, b, a, c, a, b, a, b]);
const probabilities = (model, from, temperature = 1, overrides = {}) => new Map(distribution(model, from, temperature, overrides).map(entry => [entry.id, entry.probability]));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} should equal ${expected}`);

test('rational beat operations stay exact through tuplets, dotted notes, and reductions', () => {
  assert.deepEqual(fraction(6, 4), { n: 3, d: 2 });
  assert.deepEqual(fraction(0, -24), { n: 0, d: 1 });
  assert.deepEqual(fraction(1, -3), { n: -1, d: 3 });
  assert.deepEqual(add(fraction(1, 3), fraction(1, 6)), fraction(1, 2));
  assert.deepEqual(add(add(fraction(1, 3), fraction(1, 3)), fraction(1, 3)), fraction(1));
  assert.deepEqual(sub(fraction(3, 2), fraction(1, 3)), fraction(7, 6));
  assert.equal(compare(fraction(2, 6), fraction(1, 3)), 0);
  assert.equal(compare(fraction(3, 2), fraction(5, 3)), -1);
  assert.equal(toBeats(fraction(7, 2)), 3.5);
  assert.throws(() => fraction(1, 0), /safe integer fractions/);
  assert.throws(() => fraction(0.5, 1), /safe integer fractions/);
  assert.throws(() => add(fraction(Number.MAX_SAFE_INTEGER), fraction(1)), /safe integer fractions/);
  assert.equal(compare(fraction(Number.MAX_SAFE_INTEGER), fraction(1, 2)), 1);
  assert.deepEqual(add(fraction(Number.MAX_SAFE_INTEGER, 2), fraction(-Number.MAX_SAFE_INTEGER, 3)), fraction(Number.MAX_SAFE_INTEGER, 6));
  assert.deepEqual(add(fraction(Number.MAX_SAFE_INTEGER, 2), fraction(1, 2)), fraction(2 ** 52));
});

test('state identity uses exact duration and canonical sounding pitches, with spelling retained', () => {
  const unsorted = makeSound([67, 60, 64, 67], fraction(6, 4), ['G4', 'C4', 'E4', 'G4']);
  assert.deepEqual(unsorted, { pitches: [60, 64, 67], duration: { n: 3, d: 2 }, labels: ['C4', 'E4', 'G4'] });
  assert.equal(soundName(unsorted), 'C4 · E4 · G4');
  assert.equal(soundKey(unsorted), soundKey(makeSound([64, 67, 60], fraction(3, 2))));
  assert.notEqual(soundKey(a), soundKey(makeSound([60], fraction(1, 2))));
  assert.equal(soundKey(makeSound([61], fraction(1), ['D♭4'])), soundKey(makeSound([61], fraction(1), ['C♯4'])));
  assert.equal(soundName(rest), 'Silence');
  assert.equal(durationName(a), '1 beat');
  assert.equal(durationName(unsorted), '3/2 beats');
  assert.throws(() => makeSound([60.5], fraction(1)), /whole MIDI/);
  assert.throws(() => makeSound([128], fraction(1)), /whole MIDI/);
  assert.throws(() => makeSound([60], fraction(0)), /positive duration/);
  assert.throws(() => makeSound([60], fraction(-1)), /positive duration/);
});

test('training counts adjacent sounds directionally with exact asymmetric probabilities', () => {
  const model = asymmetric();
  assert.deepEqual([...model.observed.get(A)], [[B, 3], [C, 1]]);
  assert.deepEqual([...model.observed.get(B)], [[A, 2]]);
  assert.deepEqual([...model.observed.get(C)], [[A, 1]]);
  assert.equal(model.observed.has(R), false);
  assert.equal(model.observed.get(A).has(A), false);
  const p = probabilities(model, A);
  assert.equal(p.get(B), 0.75);
  assert.equal(p.get(C), 0.25);
  close(probabilities(model, B).get(A), 2 / 3);
  close(probabilities(model, B).get(R), 1 / 3);
  for (const id of model.states.keys()) {
    close(distribution(model, id).reduce((sum, item) => sum + item.probability, 0), 1);
  }
});

test('closing edges use the final sound, quarter rest, and first sound without changing observed frequencies', () => {
  const model = asymmetric();
  assert.deepEqual([...model.counts], [[A, 4], [B, 3], [C, 1]]);
  assert.equal(model.total, 8);
  assert.deepEqual([...model.boundary.get(B)], [[R, 1]]);
  assert.deepEqual([...model.boundary.get(R)], [[A, 1]]);
  assert.equal(model.boundary.has(A), false);
  assert.equal(model.counts.has(R), false);
  assert.equal(model.observed.get(B).has(R), false);
  const halfRest = makeSound([], fraction(1, 2));
  const withShortRest = train([a, halfRest, b]);
  assert.ok(withShortRest.states.has(soundKey(halfRest)));
  assert.ok(withShortRest.states.has(R));
  assert.equal(withShortRest.transitions.get(B).get(R), 1);
});

test('a boundary rest that is also an observed state retains its original occurrence count', () => {
  const model = train([rest, a, rest]);
  assert.deepEqual([...model.counts], [[R, 2], [A, 1]]);
  assert.equal(model.total, 3);
  assert.deepEqual([...model.observed.get(R)], [[A, 1]]);
  assert.equal(model.boundary.get(R).get(R), 2);
  assert.equal(model.transitions.get(R).get(R), 2);
  close(probabilities(model, R).get(A), 1 / 3);
});

test('single-note, single-chord, and final-chord sources retain complete sound objects', () => {
  const chord = makeSound([72, 64, 67], fraction(3, 2));
  for (const single of [a, chord, rest]) {
    const model = train([single]);
    const walker = createWalker(model, { seed: 'single' });
    assert.deepEqual(walker.next().sound, single);
    assert.equal(walker.next().stateId, R);
    assert.equal(walker.next().stateId, soundKey(single));
    assert.equal(model.total, 1);
  }
  const model = train([a, chord]);
  assert.deepEqual(model.states.get(soundKey(chord)).pitches, [64, 67, 72]);
  assert.deepEqual([...model.transitions.get(soundKey(chord))], [[R, 1]]);
  assert.equal(model.sequence.at(-1), soundKey(chord));
});

test('walker emits its sampled initial state first and weights that choice by occurrence count', () => {
  const walker = createWalker(train([a, b, c]), { seed: 'first-state' });
  // This seed's first draw is 0.119..., choosing A. A's successor is B.
  assert.equal(walker.next().stateId, A);
  assert.equal(walker.next().stateId, B);
  const weighted = createWalker(asymmetric(), { seed: 'seed0' });
  // 0.366... is inside A's observed 4/8 share, but outside a uniform 1/3 share.
  assert.equal(weighted.next().stateId, A);
  for (let i = 0; i < 100; i += 1) {
    assert.notEqual(createWalker(asymmetric(), { seed: String(i) }).next().stateId, R);
  }
});

test('cumulative sampling excludes zero weights and uses the next interval at exact boundaries', () => {
  const entries = [{ id: 'zero', probability: 0 }, { id: A, probability: 0.75 }, { id: B, probability: 0.25 }, { id: 'last-zero', probability: 0 }];
  assert.equal(sample(entries, () => 0), A);
  assert.equal(sample(entries, () => 0.7499999999), A);
  assert.equal(sample(entries, () => 0.75), B);
  assert.equal(sample(entries, () => 1 - Number.EPSILON), B);
  assert.equal(sample([{ id: A, probability: 0.3 }, { id: B, probability: 0.6999999999999998 }], () => 1 - Number.EPSILON / 2), B);
  for (const invalid of [-0.01, 1, NaN, Infinity]) assert.throws(() => sample(entries, () => invalid), /\[0, 1\)/);
  assert.throws(() => sample([{ id: A, probability: 0 }], () => 0), /no available sounds/);
});

test('seeded journeys repeat exactly while other seeds can take other paths', () => {
  function journey(seed) {
    const walker = createWalker(asymmetric(), { seed });
    return Array.from({ length: 128 }, () => walker.next().stateId);
  }
  assert.deepEqual(journey('same journey'), journey('same journey'));
  assert.notDeepEqual(journey('same journey'), journey('different journey'));
  const random = seededRandom('range');
  for (let i = 0; i < 10000; i += 1) {
    const draw = random();
    assert.ok(draw >= 0 && draw < 1);
  }
});

test('Surprise reshapes only existing connections and normalizes edited positive weights', () => {
  const model = asymmetric();
  const edits = { [A]: { [B]: 9, [C]: 1 } };
  close(probabilities(model, A, 1, edits).get(B), 0.9);
  close(probabilities(model, A, 0.5, edits).get(B), 81 / 82);
  close(probabilities(model, A, 2, edits).get(B), 0.75);
  assert.deepEqual([...probabilities(model, A, 2, edits).keys()], [B, C]);
  assert.equal(probabilities(model, A, 2, { [A]: { [B]: 0 } }).get(B), 0);
  assert.equal(probabilities(model, A, 2, { [A]: { [B]: 0 } }).get(C), 1);
  assert.equal(model.transitions.get(A).get(B), 3);
  close(probabilities(model, A, 0.5, { [A]: { [B]: 2e-200, [C]: 1e-200 } }).get(B), 0.8);
});

test('probability edits reject unknown connections, invalid weights, and removal of the last path', () => {
  const model = asymmetric();
  for (const value of [-1, NaN, Infinity, 1_000_001, '2']) {
    assert.throws(() => validateOverrides(model, { [A]: { [B]: value } }), /weights must be finite/);
  }
  assert.throws(() => validateOverrides(model, { [A]: { [B]: 0, [C]: 0 } }), /at least one connection/);
  assert.throws(() => validateOverrides(model, { [C]: { [A]: 0 } }), /at least one connection/);
  assert.throws(() => validateOverrides(model, { unknown: {} }), /unknown sound/);
  assert.throws(() => validateOverrides(model, { [A]: { [R]: 1 } }), /unknown connection/);
  assert.throws(() => validateOverrides(model, []), /Invalid connection/);
  for (const temperature of [0.49, 2.01, NaN]) assert.throws(() => distribution(model, A, temperature), /Surprise/);
  validateOverrides(model, { [A]: { [B]: 0 } });
});

test('walker accepts live edits and can resume from the final frozen state', () => {
  const walker = createWalker(asymmetric(), { seed: 'live' });
  walker.next();
  walker.update({ overrides: { [A]: { [B]: 0 } }, temperature: 2 });
  walker.setCurrent(A);
  assert.equal(walker.next().stateId, C);
  walker.update({ overrides: { [A]: { [C]: 0 } } });
  walker.setCurrent(A);
  assert.equal(walker.next().stateId, B);
  assert.throws(() => walker.setCurrent('missing'), /Unknown restart/);
});

test('every original example contains branches, recurring states, chords, and silence', () => {
  assert.equal(examples.length, 4);
  assert.equal(new Set(examples.map(example => example.id)).size, 4);
  assert.equal(examples[0].tempo, 96);
  for (const example of examples) {
    const model = train(example.events);
    assert.ok([...model.observed.values()].some(row => row.size > 1), `${example.name} needs observed branching`);
    assert.ok([...model.counts.values()].some(count => count > 1), `${example.name} needs a recurring sound`);
    assert.ok(example.events.some(sound => sound.pitches.length > 1), `${example.name} needs a chord`);
    assert.ok(example.events.some(sound => sound.pitches.length === 0), `${example.name} needs silence`);
    const walker = createWalker(model, { seed: example.id });
    for (let i = 0; i < 200; i += 1) assert.ok(model.states.has(walker.next().stateId));
  }
});

test('training rejects empty or oversized sources and counts the closure state toward the limit', () => {
  assert.throws(() => train([]), /at least one sound/);
  assert.throws(() => train(Array(4097).fill(a)), /4,096/);
  const events = Array.from({ length: 512 }, (_, i) => makeSound([60], fraction(i + 1)));
  assert.throws(() => train(events), /512 states/);
  events.pop();
  assert.equal(train(events).states.size, 512);
});
