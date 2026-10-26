import { add, compare, fraction, makeSound, soundKey, sub } from '../core/music.js';

export const LIMITS = Object.freeze({ fileBytes: 5 * 1024 * 1024, expandedBytes: 20 * 1024 * 1024, xmlBytes: 10 * 1024 * 1024, notes: 10000, events: 4096, states: 512 });
export const ZERO = fraction(0);

export function decimal(value, label = 'Number') {
  const text = String(value ?? '').trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new Error(`${label} must be a finite decimal number.`);
  const places = (text.split('.')[1] || '').length;
  return fraction(Math.round(Number(text) * 10 ** places), 10 ** places);
}

export function ratio(a, b) { return fraction(a.n * b.d, a.d * b.n); }
export function maxTime(a, b) { return compare(a, b) >= 0 ? a : b; }
export function warning(list, message) { if (!list.includes(message)) list.push(message); }
export function normalizeTempo(value, warnings) {
  const tempo = value == null ? 96 : Number(value);
  if (!Number.isFinite(tempo) || tempo <= 0) throw new Error('The source contains an invalid tempo.');
  const bounded = Math.min(240, Math.max(30, tempo));
  if (bounded !== tempo) warning(warnings, `Source tempo ${tempo} BPM was limited to ${bounded} BPM (supported range: 30–240).`);
  return bounded;
}

/** Convert an absolute note timeline into the paper's sequential pitch-set states. */
export function normalizeTimeline(notes, end, warnings = [], restBoundaries = []) {
  if (notes.length > LIMITS.notes) throw new Error('This part has more than 10,000 notes. Import a shorter excerpt.');
  if (compare(end, ZERO) <= 0) throw new Error('This part contains no timed music.');
  const boundaries = new Map();
  const at = (time) => {
    const key = `${time.n}/${time.d}`;
    if (!boundaries.has(key)) boundaries.set(key, { time, starts: [], ends: [] });
    return boundaries.get(key);
  };
  at(ZERO); at(end);
  for (const boundary of restBoundaries) at(boundary).restBoundary = true;
  notes.forEach((note, id) => {
    if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) throw new Error('Only whole MIDI pitches from 0 to 127 are supported.');
    if (compare(note.start, ZERO) < 0 || compare(note.end, note.start) <= 0) throw new Error('A source note has invalid timing.');
    at(note.start).starts.push({ ...note, id });
    at(note.end).ends.push(id);
  });
  const times = [...boundaries.values()].sort((a, b) => compare(a.time, b.time));
  const active = new Map();
  const events = [];
  let resliced = false;
  for (let i = 0; i < times.length - 1; i++) {
    const point = times[i];
    for (const id of point.ends) active.delete(id);
    if (i > 0 && active.size && (point.ends.length || point.starts.length)) resliced = true;
    for (const note of point.starts) active.set(note.id, note);
    const byPitch = new Map();
    for (const note of active.values()) if (!byPitch.has(note.pitch)) byPitch.set(note.pitch, note.label || String(note.pitch));
    const pitches = [...byPitch.keys()].sort((a, b) => a - b);
    const labels = pitches.map(pitch => byPitch.get(pitch));
    const duration = sub(times[i + 1].time, point.time);
    // Keep real note boundaries even when adjacent pitch sets happen to match.
    // Explicit written rests remain separate source states while silent, but
    // another voice's rest must not cut an otherwise sustained sounding note.
    const previous = events.at(-1);
    const unchangedSound = pitches.length && !point.starts.length && !point.ends.length && previous?.pitches.length === pitches.length && pitches.every((pitch, index) => previous.pitches[index] === pitch);
    const continuousSilence = !pitches.length && previous && !previous.pitches.length && !point.restBoundary;
    if (unchangedSound || continuousSilence) {
      events.at(-1).duration = add(events.at(-1).duration, duration);
    } else events.push(makeSound(pitches, duration, labels));
    if (events.length > LIMITS.events) throw new Error('This part becomes more than 4,096 sound objects. Import a shorter excerpt.');
  }
  const keys = new Set(events.map(soundKey));
  keys.add(soundKey(makeSound([], fraction(1))));
  if (keys.size > LIMITS.states) throw new Error('This part needs more than 512 states, including the closing rest. Import a shorter or simpler excerpt.');
  if (resliced) warning(warnings, 'Overlapping notes became chord snapshots. Sustained notes can retrigger when another note changes.');
  return events;
}
