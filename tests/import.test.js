import test from 'node:test';
import assert from 'node:assert/strict';
import { writeMidi } from 'midi-file';
import { fraction, makeSound, soundKey } from '../src/core/music.js';
import { inspectBytes, inspectFile, LIMITS } from '../src/import/index.js';
import { decimal, normalizeTimeline } from '../src/import/normalize.js';

const note = (pitch, start, end) => ({ pitch, start: fraction(start), end: fraction(end), label: `Pitch ${pitch}` });
const on = (pitch, deltaTime = 0, channel = 0) => ({ type: 'noteOn', deltaTime, channel, noteNumber: pitch, velocity: 80 });
const off = (pitch, deltaTime = 0, channel = 0) => ({ type: 'noteOff', deltaTime, channel, noteNumber: pitch, velocity: 0 });
const end = (deltaTime = 0) => ({ type: 'endOfTrack', meta: true, deltaTime });
const bytes = (tracks, header = {}) => Uint8Array.from(writeMidi({ header: { format: 1, numTracks: tracks.length, ticksPerBeat: 480, ...header }, tracks }));
const read = async (track, header) => (await inspectBytes('music.mid', bytes([track], header))).readPart('track:0');

test('snapshot normalization exposes overlaps, preserves attacks, and fills rests', () => {
  const warnings = [];
  const events = normalizeTimeline([note(60, 1, 5), note(64, 2, 3), note(67, 3, 4), note(60, 5, 6)], fraction(7), warnings);
  assert.deepEqual(events.map(s => s.pitches), [[], [60], [60, 64], [60, 67], [60], [60], []]);
  assert.ok(events.every(s => s.duration.n === 1 && s.duration.d === 1));
  assert.match(warnings.join(' '), /Sustained notes can retrigger/);
});

test('simultaneous block chords do not report overlap simplification', () => {
  const warnings = [];
  const events = normalizeTimeline([note(60, 0, 1), note(64, 0, 1), note(60, 1, 2), note(64, 1, 2)], fraction(2), warnings);
  assert.equal(events.length, 2);
  assert.equal(warnings.length, 0);
  assert.equal(soundKey(events[0]), soundKey(events[1]));
});

test('fractional boundaries are exact and pitches canonicalized', () => {
  const notes = [{ pitch: 64, label: 'E4', start: fraction(0), end: fraction(1, 3) }, { pitch: 60, label: 'C4', start: fraction(0), end: fraction(1, 3) }];
  const [event] = normalizeTimeline(notes, fraction(1, 3));
  assert.deepEqual(event, makeSound([60, 64], fraction(1, 3), ['C4', 'E4']));
  assert.deepEqual(decimal('0.125'), fraction(1, 8));
  assert.throws(() => decimal('NaN'), /finite decimal/);
});

test('all-rest timelines remain a valid single duration-bearing event', () => {
  assert.deepEqual(normalizeTimeline([], fraction(3)), [makeSound([], fraction(3))]);
  assert.throws(() => normalizeTimeline([], fraction(0)), /no timed music/);
});

test('explicit rest boundaries preserve silent source states without cutting held notes', () => {
  const boundaries = [fraction(0), fraction(1), fraction(2)];
  assert.deepEqual(normalizeTimeline([], fraction(2), [], boundaries), [makeSound([], fraction(1)), makeSound([], fraction(1))]);
  assert.deepEqual(normalizeTimeline([note(60, 0, 2)], fraction(2), [], boundaries), [makeSound([60], fraction(2), ['Pitch 60'])]);
});

test('normalized event and state limits include the closing rest', () => {
  assert.throws(() => normalizeTimeline(Array.from({ length: 4097 }, (_, i) => note(60, i, i + 1)), fraction(4097)), /4,096/);
  let time = 0;
  const manyStates = Array.from({ length: 512 }, (_, i) => { const start = time; time += i + 1; return note(60, start, time); });
  assert.throws(() => normalizeTimeline(manyStates, fraction(time)), /512 states/);
  assert.throws(() => normalizeTimeline(Array.from({ length: 10001 }, () => note(60, 0, 1)), fraction(1)), /10,000/);
});

test('MIDI inspector offers only tracks with notes and reads global tempo', async () => {
  const data = bytes([
    [{ type: 'setTempo', meta: true, microsecondsPerBeat: 500000, deltaTime: 0 }, end()],
    [{ type: 'trackName', meta: true, text: 'Keys', deltaTime: 0 }, on(60), on(64), off(60, 480), off(64), end()]
  ]);
  const score = await inspectBytes('keys.mid', data);
  assert.deepEqual(score.parts, [{ id: 'track:1', name: 'Keys' }]);
  const result = score.readPart('track:1');
  assert.equal(result.tempo, 120);
  assert.deepEqual(result.events[0], makeSound([60, 64], fraction(1), ['C4', 'E4']));
  assert.throws(() => score.readPart('track:0'), /Select a track/);
});

test('MIDI quantization preserves repeated notes and noteOn velocity zero note-offs', async () => {
  const result = await read([on(60), { ...on(60, 241), velocity: 0 }, on(60), off(60, 239), end()], { format: 0 });
  assert.deepEqual(result.events.map(event => event.duration), [fraction(1, 2), fraction(1, 2)]);
  assert.equal(result.events.length, 2);
  assert.equal(result.tempo, 96);
});

test('MIDI quantization gives sub-grid notes a positive duration and reports it', async () => {
  const result = await read([on(60), off(60, 1), end()]);
  assert.deepEqual(result.events[0].duration, fraction(1, 24));
  assert.match(result.warnings.join(' '), /extended to 1\/24/);
});

test('MIDI pairing supports overlapping attacks of one pitch in arrival order', async () => {
  const result = await read([on(60), on(60, 240), off(60, 240), off(60, 240), end()]);
  assert.equal(result.events.length, 3);
  assert.match(result.warnings.join(' '), /arrival order/);
});

test('MIDI trailing silence and controller limitations are explicit', async () => {
  const result = await read([on(60), { type: 'controller', channel: 0, controllerType: 64, value: 127, deltaTime: 0 }, { type: 'pitchBend', channel: 0, value: 50, deltaTime: 0 }, off(60, 480), end(480)]);
  assert.deepEqual(result.events.map(event => event.pitches), [[60], []]);
  assert.match(result.warnings.join(' '), /Sustain pedal/);
  assert.match(result.warnings.join(' '), /Pitch bend/);
});

test('MIDI rejects percussion, unmatched note-ons, format 2 and SMPTE', async () => {
  await assert.rejects(read([on(60, 0, 9), off(60, 480, 9), end()]), /percussion/);
  await assert.rejects(read([on(60), end(480)]), /without matching/);
  await assert.rejects(inspectBytes('a.mid', bytes([[on(60), off(60, 480), end()]], { format: 2 })), /format 2/);
  const smpte = bytes([[on(60), off(60, 480), end()]]);
  smpte[12] = 0xe7; smpte[13] = 40;
  await assert.rejects(inspectBytes('a.mid', smpte), /SMPTE/);
});

test('tempo clamps to app range and changing source tempo is disclosed', async () => {
  const result = await read([{ type: 'setTempo', meta: true, microsecondsPerBeat: 100000, deltaTime: 0 }, on(60), { type: 'setTempo', meta: true, microsecondsPerBeat: 500000, deltaTime: 0 }, off(60, 480), end()]);
  assert.equal(result.tempo, 240);
  assert.match(result.warnings.join(' '), /limited to 240/);
  assert.match(result.warnings.join(' '), /Tempo changes/);
});

test('file boundaries reject oversize, empty, and malformed content before parsing', async () => {
  await assert.rejects(inspectBytes('a.mid', new Uint8Array()), /empty/);
  await assert.rejects(inspectBytes('a.mid', new Uint8Array(LIMITS.fileBytes + 1)), /5 MiB/);
  await assert.rejects(inspectBytes('a.mid', new TextEncoder().encode('MThd')), /malformed/);
  await assert.rejects(inspectBytes('a.mid', new TextEncoder().encode('oops')), /valid MIDI/);
  let accessed = false;
  await assert.rejects(inspectFile({ name: 'a.mid', size: LIMITS.fileBytes + 1, arrayBuffer() { accessed = true; } }), /5 MiB/);
  assert.equal(accessed, false);
});
