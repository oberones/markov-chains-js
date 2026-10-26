import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMidi } from 'midi-file';
import { encodeWav, renderMidi, renderWav } from '../src/audio/export.js';
import { normalizeAudioSettings, soundDuration } from '../src/audio/synth.js';

const event = (stateId, pitches, n, d = 1) => ({ stateId, sound: { pitches, duration: { n, d }, labels: [] } });

test('MIDI preserves simultaneous chords, triplets, rests, tempo and off-before-on ordering', () => {
  const clip = { events: [event('a', [60, 64, 67], 1, 3), event('silence', [], 1, 3), event('b', [60], 1, 3), event('c', [60], 1)] };
  const midi = parseMidi(renderMidi(clip, { tempo: 120 }));
  assert.equal(midi.header.ticksPerBeat, 960);
  let tick = 0;
  const events = midi.tracks[0].map((entry) => ({ ...entry, tick: tick += entry.deltaTime }));
  assert.equal(events[0].microsecondsPerBeat, 500000);
  assert.deepEqual(events.filter((entry) => entry.type === 'noteOn').map((entry) => [entry.tick, entry.noteNumber]), [[0, 60], [0, 64], [0, 67], [640, 60], [960, 60]]);
  assert.deepEqual(events.filter((entry) => entry.tick === 960).map((entry) => entry.type), ['noteOff', 'noteOn']);
  assert.equal(events.at(-1).type, 'endOfTrack');
  assert.equal(events.at(-1).tick, 1920);
});

test('MIDI includes a final rest and a rest-only phrase duration', () => {
  const midi = parseMidi(renderMidi({ events: [event('rest', [], 7, 3)] }));
  assert.equal(midi.tracks[0].at(-1).deltaTime, 2240);
  assert.equal(midi.tracks[0].filter((e) => e.type === 'noteOn').length, 0);
});

test('sub-tick durations stay sequential and every note stops before EndOfTrack', () => {
  const midi = parseMidi(renderMidi({ events: [event('a', [60], 1, 32767), event('rest', [], 1, 32767), event('b', [60], 1, 32767)] }));
  let tick = 0;
  const events = midi.tracks[0].map((entry) => ({ ...entry, tick: tick += entry.deltaTime }));
  assert.deepEqual(events.filter((e) => e.type === 'noteOn' || e.type === 'noteOff').map((e) => [e.tick, e.type]), [[0, 'noteOn'], [1, 'noteOff'], [2, 'noteOn'], [3, 'noteOff']]);
  assert.equal(events.at(-1).type, 'endOfTrack');
  assert.equal(events.at(-1).tick, 3);
});

test('WAV encoder writes correct stereo PCM header and clamps finite samples', () => {
  const values = [Float32Array.from([-2, -0.5, 0.5, 2]), Float32Array.from([1, 0, -1, 0.25])];
  const wav = encodeWav({ length: 4, numberOfChannels: 2, sampleRate: 44100, getChannelData: (channel) => values[channel] });
  const view = new DataView(wav);
  assert.equal(wav.byteLength, 60);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 16);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(46, true), 32767);
});

test('exports reject empty clips, invalid pitches and oversized audio without truncating', async () => {
  assert.throws(() => renderMidi({ events: [] }), /Freeze a phrase/);
  assert.throws(() => renderMidi({ events: [event('bad', [128], 1)] }), /MIDI note/);
  await assert.rejects(renderWav({ events: [event('long', [60], 400)] }, { tempo: 60 }), /longer than 3 minutes/);
});

test('audio settings retain sensible bounds and do not cap long note durations', () => {
  assert.deepEqual(normalizeAudioSettings({ tempo: 1, volume: 9, preset: 'unknown' }), { tempo: 30, volume: 1, preset: 'warm' });
  assert.deepEqual(normalizeAudioSettings({ tempo: NaN, volume: NaN }), { tempo: 96, volume: 0.65, preset: 'warm' });
  assert.equal(soundDuration(event('long', [60], 16).sound, 120), 8);
});
