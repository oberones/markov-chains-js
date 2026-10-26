import { toBeats } from '../core/music.js';

export const PRESETS = Object.freeze({
  warm: Object.freeze({ wave: 'triangle', second: 'sine', blend: 0.24, detune: 4, attack: 0.035, release: 0.34, cutoff: 3000, shimmer: 0.02 }),
  glassy: Object.freeze({ wave: 'sine', second: 'sine', blend: 0.20, detune: 8, attack: 0.008, release: 0.68, cutoff: 10000, shimmer: 0.18 }),
  organ: Object.freeze({ wave: 'sine', second: 'square', blend: 0.15, detune: 0, attack: 0.012, release: 0.11, cutoff: 3800, shimmer: 0.13 }),
  dark: Object.freeze({ wave: 'triangle', second: 'sawtooth', blend: 0.12, detune: -5, attack: 0.07, release: 0.46, cutoff: 1100, shimmer: 0 }),
  shimmer: Object.freeze({ wave: 'sine', second: 'triangle', blend: 0.25, detune: 11, attack: 0.09, release: 0.95, cutoff: 6500, shimmer: 0.22 }),
});

export const DEFAULT_AUDIO_SETTINGS = Object.freeze({ tempo: 96, preset: 'warm', volume: 0.65 });
export const AUDIO_TAIL_SECONDS = 1.05;

export function normalizeAudioSettings(settings = {}, previous = DEFAULT_AUDIO_SETTINGS) {
  const tempo = Number(settings.tempo ?? previous.tempo);
  const volume = Number(settings.volume ?? previous.volume);
  const preset = settings.preset ?? previous.preset;
  return {
    tempo: Number.isFinite(tempo) ? Math.max(30, Math.min(240, tempo)) : previous.tempo,
    preset: Object.hasOwn(PRESETS, preset) ? preset : previous.preset,
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : previous.volume,
  };
}

export function soundDuration(sound, tempo) {
  if (!sound?.duration || !Number.isSafeInteger(sound.duration.n) || !Number.isSafeInteger(sound.duration.d) || sound.duration.n <= 0 || sound.duration.d <= 0) {
    throw new TypeError('Every sound needs a positive duration.');
  }
  const duration = toBeats(sound?.duration) * 60 / tempo;
  if (!Number.isFinite(duration) || duration <= 0) throw new TypeError('Every sound needs a positive duration.');
  if (!Array.isArray(sound.pitches) || sound.pitches.some((pitch) => !Number.isInteger(pitch) || pitch < 0 || pitch > 127)) {
    throw new TypeError('Sound pitches must be MIDI note numbers from 0 to 127.');
  }
  return duration;
}

/** The same graph and envelopes are used for live playback and WAV rendering. */
export function createSynth(context, initialSettings = {}) {
  let settings = normalizeAudioSettings(initialSettings);
  const master = context.createGain();
  const compressor = context.createDynamicsCompressor();
  const analyser = context.createAnalyser();
  master.gain.value = settings.volume;
  compressor.threshold.value = -12;
  compressor.knee.value = 12;
  compressor.ratio.value = 8;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.18;
  analyser.fftSize = 256;
  master.connect(compressor);
  compressor.connect(analyser);
  analyser.connect(context.destination);
  let voices = [];
  let disposed = false;

  function update(next) {
    settings = normalizeAudioSettings(next, settings);
    const now = context.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setTargetAtTime(settings.volume, now, 0.025);
  }

  function scheduleSound(sound, when, eventSettings = settings) {
    if (disposed) throw new Error('The audio session has ended.');
    const config = normalizeAudioSettings(eventSettings, settings);
    const duration = soundDuration(sound, config.tempo);
    const profile = PRESETS[config.preset];
    const pitches = [...new Set(sound.pitches)];
    const group = [];
    const endTime = when + duration;
    const attack = Math.min(profile.attack, duration * 0.3);
    // A short event still sounds for its full musical duration. Long notes are never capped.
    const releaseAt = endTime;
    const stopAt = releaseAt + profile.release;
    voices = voices.filter((voice) => voice.endTime > when);

    pitches.forEach((pitch, index) => {
      while (voices.length >= 256) {
        const releasingIndex = voices.findIndex((voice) => voice.releaseAt <= when);
        if (releasingIndex < 0) throw new RangeError('Too many sustained voices are playing at once.');
        const oldest = voices.splice(releasingIndex, 1)[0];
        const fadeAt = Math.max(context.currentTime, oldest.releaseAt, when - 0.008);
        oldest.cancel(fadeAt, Math.max(0, when - fadeAt));
      }
      const envelope = context.createGain();
      const filter = context.createBiquadFilter();
      const panner = context.createStereoPanner();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(profile.cutoff, when);
      filter.Q.value = 0.35;
      panner.pan.setValueAtTime(pitches.length > 1 ? (index / (pitches.length - 1) - 0.5) * 0.75 : 0, when);
      const level = 0.19 / Math.sqrt(Math.max(1, pitches.length));
      envelope.gain.setValueAtTime(0, when);
      envelope.gain.linearRampToValueAtTime(level, when + attack);
      envelope.gain.setValueAtTime(level, releaseAt);
      envelope.gain.linearRampToValueAtTime(0, stopAt);
      envelope.connect(filter);
      filter.connect(panner);
      panner.connect(master);
      const frequency = 440 * 2 ** ((pitch - 69) / 12);
      const layers = [
        [profile.wave, 1, 0, 1 - profile.blend],
        [profile.second, 1, profile.detune, profile.blend],
        ['sine', 2, 0, profile.shimmer],
      ].filter((layer) => layer[3] > 0);
      const nodes = [];
      let ended = 0;
      const voice = {
        endTime: stopAt,
        releaseAt,
        cancel(at = context.currentTime, fade = 0.04) {
          const cut = Math.max(context.currentTime, at);
          if (cut <= when) {
            envelope.gain.cancelScheduledValues(cut);
            envelope.gain.setValueAtTime(0, cut);
          } else {
            if (envelope.gain.cancelAndHoldAtTime) envelope.gain.cancelAndHoldAtTime(cut);
            else {
              envelope.gain.cancelScheduledValues(cut);
              envelope.gain.setValueAtTime(level, cut);
            }
            envelope.gain.linearRampToValueAtTime(0, cut + fade);
          }
          nodes.forEach(({ oscillator }) => {
            try { oscillator.stop(cut <= when ? cut : cut + fade); } catch { /* Already ended. */ }
          });
          voice.endTime = cut + fade;
        },
      };
      layers.forEach(([wave, multiple, detune, mix]) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = wave;
        oscillator.frequency.setValueAtTime(frequency * multiple, when);
        oscillator.detune.setValueAtTime(detune, when);
        gain.gain.setValueAtTime(mix, when);
        oscillator.connect(gain);
        gain.connect(envelope);
        oscillator.onended = () => {
          oscillator.disconnect();
          gain.disconnect();
          ended += 1;
          if (ended === layers.length) {
            envelope.disconnect();
            filter.disconnect();
            panner.disconnect();
          }
        };
        oscillator.start(when);
        oscillator.stop(stopAt + 0.005);
        nodes.push({ oscillator, gain });
      });
      voices.push(voice);
      group.push(voice);
    });
    return { endTime, cancel: (at, fade) => group.forEach((voice) => voice.cancel(at, fade)) };
  }

  function stop(at = context.currentTime) {
    voices.forEach((voice) => voice.cancel(at));
    voices = [];
  }

  function dispose() {
    stop();
    disposed = true;
    // The transport keeps this graph alive for its short fade, then disconnects it.
    master.disconnect();
    compressor.disconnect();
    analyser.disconnect();
  }

  return { scheduleSound, update, stop, dispose, analyser };
}
