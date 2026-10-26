import { writeMidi } from 'midi-file';
import { toBeats } from '../core/music.js';
import { AUDIO_TAIL_SECONDS, createSynth, normalizeAudioSettings, soundDuration } from './synth.js';

const SAMPLE_RATE = 44100;
const MAX_EXPORT_SECONDS = 180;
const PPQ = 960;

export function validateClip(clip) {
  if (!clip || !Array.isArray(clip.events) || clip.events.length === 0) {
    throw new TypeError('Freeze a phrase before exporting it.');
  }
  clip.events.forEach((event) => {
    if (!event || typeof event.stateId !== 'string') throw new TypeError('The phrase contains an invalid event.');
    soundDuration(event.sound, 60);
  });
  return clip;
}

export async function renderWav(clip, options = {}) {
  validateClip(clip);
  const settings = normalizeAudioSettings(options);
  const lengthSeconds = clip.events.reduce((sum, event) => sum + soundDuration(event.sound, settings.tempo), 0);
  if (lengthSeconds > MAX_EXPORT_SECONDS) {
    throw new RangeError('This phrase is longer than 3 minutes. Freeze fewer events or increase the pace before exporting WAV.');
  }
  const OfflineContext = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
  if (!OfflineContext) throw new Error('This browser does not support offline audio rendering.');
  const context = new OfflineContext(2, Math.ceil((lengthSeconds + AUDIO_TAIL_SECONDS) * SAMPLE_RATE), SAMPLE_RATE);
  const synth = createSynth(context, settings);
  let time = 0;
  clip.events.forEach(({ sound }) => {
    synth.scheduleSound(sound, time, settings);
    time += soundDuration(sound, settings.tempo);
  });
  try {
    const buffer = await context.startRendering();
    return encodeWav(buffer);
  } finally {
    synth.dispose();
  }
}

export function encodeWav(buffer) {
  const frames = buffer.length;
  const result = new ArrayBuffer(44 + frames * 4);
  const data = new DataView(result);
  const writeText = (offset, text) => [...text].forEach((char, index) => data.setUint8(offset + index, char.charCodeAt(0)));
  writeText(0, 'RIFF');
  data.setUint32(4, result.byteLength - 8, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 2, true);
  data.setUint32(24, buffer.sampleRate, true);
  data.setUint32(28, buffer.sampleRate * 4, true);
  data.setUint16(32, 4, true);
  data.setUint16(34, 16, true);
  writeText(36, 'data');
  data.setUint32(40, frames * 4, true);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(buffer.numberOfChannels > 1 ? 1 : 0);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < 2; channel += 1) {
      const sample = Math.max(-1, Math.min(1, (channel ? right : left)[frame]));
      data.setInt16(44 + frame * 4 + channel * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
  }
  return result;
}

export function renderMidi(clip, options = {}) {
  validateClip(clip);
  const { tempo } = normalizeAudioSettings(options);
  const timedEvents = [{ tick: 0, priority: 0, event: { type: 'setTempo', microsecondsPerBeat: Math.round(60000000 / tempo) } }];
  let beats = 0;
  let cursorTick = 0;
  clip.events.forEach(({ sound }) => {
    const startTick = cursorTick;
    beats += toBeats(sound.duration);
    const endTick = Math.max(startTick + 1, Math.round(beats * PPQ));
    cursorTick = endTick;
    [...new Set(sound.pitches)].forEach((pitch) => {
      timedEvents.push({ tick: startTick, priority: 2, event: { type: 'noteOn', channel: 0, noteNumber: pitch, velocity: 90 } });
      timedEvents.push({ tick: endTick, priority: 1, event: { type: 'noteOff', channel: 0, noteNumber: pitch, velocity: 0 } });
    });
  });
  timedEvents.push({ tick: cursorTick, priority: 3, event: { type: 'endOfTrack' } });
  timedEvents.sort((a, b) => a.tick - b.tick || a.priority - b.priority);
  let previousTick = 0;
  const track = timedEvents.map(({ tick, event }) => {
    const value = { ...event, deltaTime: tick - previousTick };
    previousTick = tick;
    return value;
  });
  return Uint8Array.from(writeMidi({ header: { format: 0, ticksPerBeat: PPQ }, tracks: [track] }));
}
