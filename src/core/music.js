/** @typedef {{n:number,d:number}} Fraction */
/** @typedef {{pitches:number[],duration:Fraction,labels:string[]}} SoundObject */

const safe = Number.isSafeInteger;
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }

/** Reduced, exact fraction. Zero and negatives are allowed for timeline arithmetic. */
export function fraction(n, d = 1) {
  if (!safe(n) || !safe(d) || d === 0) throw new Error('Timing must use safe integer fractions.');
  if (d < 0) { n = -n; d = -d; }
  const divisor = gcd(Math.abs(n), d);
  return { n: n === 0 ? 0 : n / divisor, d: d / divisor };
}
function fromExact(n, d) {
  let x = n < 0n ? -n : n;
  let y = d;
  while (y) [x, y] = [y, x % y];
  return fraction(Number(n / x), Number(d / x));
}
export function add(a, b) {
  a = fraction(a.n, a.d); b = fraction(b.n, b.d);
  return fromExact(BigInt(a.n) * BigInt(b.d) + BigInt(b.n) * BigInt(a.d), BigInt(a.d) * BigInt(b.d));
}
export function sub(a, b) { return add(a, {n: -b.n, d: b.d}); }
export function compare(a, b) {
  a = fraction(a.n, a.d); b = fraction(b.n, b.d);
  const delta = BigInt(a.n) * BigInt(b.d) - BigInt(b.n) * BigInt(a.d);
  return delta === 0n ? 0 : delta < 0n ? -1 : 1;
}
export function toBeats(a) { return a.n / a.d; }

/** Canonical sounding pitch sets; spelling is display metadata, not a separate state. */
export function makeSound(pitches, duration, labels = []) {
  if (!Array.isArray(pitches) || pitches.some(p => !Number.isInteger(p) || p < 0 || p > 127)) throw new Error('Pitches must be whole MIDI notes from 0 to 127.');
  const normalized = fraction(duration.n, duration.d);
  if (normalized.n <= 0) throw new Error('Sounds need a positive duration.');
  const sorted = [...new Set(pitches)].sort((a, b) => a - b);
  const spellings = labels.map(String);
  const byPitch = new Map(pitches.map((pitch, index) => [pitch, spellings[index]]));
  return { pitches: sorted, duration: normalized, labels: labels.length === pitches.length ? sorted.map(pitch => byPitch.get(pitch)) : spellings };
}
export function soundKey(sound) { const s = makeSound(sound.pitches, sound.duration); return JSON.stringify([s.pitches, s.duration.n, s.duration.d]); }
export function noteName(midi) { return ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'][midi % 12] + (Math.floor(midi / 12) - 1); }
export function soundName(sound) { return sound.pitches.length ? (sound.labels.length === sound.pitches.length ? sound.labels : sound.pitches.map(noteName)).join(' · ') : 'Silence'; }
export function durationName(sound) { const {n,d} = sound.duration; return `${d === 1 ? n : `${n}/${d}`} ${n === d ? 'beat' : 'beats'}`; }
