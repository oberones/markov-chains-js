import { fraction, makeSound, soundKey } from './music.js';

/** @typedef {{states:Map<string,import('./music.js').SoundObject>,counts:Map<string,number>,transitions:Map<string,Map<string,number>>,observed:Map<string,Map<string,number>>,boundary:Map<string,Map<string,number>>,sequence:string[],total:number}} MarkovModel */
function increment(map, from, to) {
  if (!map.has(from)) map.set(from, new Map());
  map.get(from).set(to, (map.get(from).get(to) || 0) + 1);
}

/** Train a directed, first-order chain. Artificial closing edges never affect occurrence frequencies. */
export function train(events) {
  if (!Array.isArray(events) || events.length === 0) throw new Error('Choose a source with at least one sound or rest.');
  if (events.length > 4096) throw new Error('This source has more than 4,096 sound objects. Choose a shorter excerpt.');
  const model = {states:new Map(), counts:new Map(), transitions:new Map(), observed:new Map(), boundary:new Map(), sequence:[], total:events.length};
  for (const event of events) {
    const sound = makeSound(event.pitches, event.duration, event.labels || []);
    const id = soundKey(sound);
    if (!model.states.has(id)) model.states.set(id, sound);
    model.counts.set(id, (model.counts.get(id) || 0) + 1);
    model.sequence.push(id);
  }
  const rest = makeSound([], fraction(1));
  const restId = soundKey(rest);
  if (!model.states.has(restId)) model.states.set(restId, rest);
  if (model.states.size > 512) throw new Error('This source needs more than 512 states including its closing rest. Choose a shorter excerpt.');
  for (let i = 1; i < model.sequence.length; i++) {
    increment(model.transitions, model.sequence[i-1], model.sequence[i]);
    increment(model.observed, model.sequence[i-1], model.sequence[i]);
  }
  for (const [from, to] of [[model.sequence.at(-1), restId], [restId, model.sequence[0]]]) {
    increment(model.transitions, from, to);
    increment(model.boundary, from, to);
  }
  return model;
}

/** Stable Mulberry32 generator: each journey's seed fully determines its random draws. */
export function seededRandom(seed) {
  let state = 2166136261;
  for (const c of String(seed)) { state ^= c.codePointAt(0); state = Math.imul(state, 16777619); }
  return function () {
    let t = state = (state + 0x6D2B79F5) | 0;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function distribution(model, from, temperature = 1, overrides = {}) {
  if (!Number.isFinite(temperature) || temperature < 0.5 || temperature > 2) throw new Error('Surprise must be between 0.5 and 2.');
  const row = model.transitions.get(from);
  if (!row) throw new Error('Unknown sound.');
  const entries = [...row].map(([id, count]) => {
    const edit = Object.hasOwn(overrides, from) && Object.hasOwn(overrides[from], id) ? overrides[from][id] : count;
    if (!Number.isFinite(edit) || edit < 0 || edit > 1000000) throw new Error('Connection weights must be finite and non-negative.');
    return {id, count, weight:edit};
  });
  // Dividing every weight by the same maximum preserves the normalized result
  // while allowing very small positive edits to remain usable at low Surprise.
  const maximum = Math.max(...entries.map(e => e.weight));
  if (!(maximum > 0)) throw new Error('Keep at least one connection above zero.');
  for (const entry of entries) entry.transformed = Math.pow(entry.weight / maximum, 1 / temperature);
  const total = entries.reduce((sum, e) => sum + e.transformed, 0);
  if (!(total > 0)) throw new Error('Keep at least one connection above zero.');
  return entries.map(e => ({...e, probability:e.transformed / total}));
}

export function sample(entries, random) {
  const u = random();
  if (!(u >= 0 && u < 1)) throw new Error('Random draws must be in [0, 1).');
  let sum = 0;
  let last;
  for (const entry of entries) {
    if (!(entry.probability > 0)) continue;
    last = entry.id;
    sum += entry.probability;
    if (u < sum) return entry.id;
  }
  if (last === undefined) throw new Error('There are no available sounds.');
  return last; // Roundoff at the end of a normalized row.
}

export function validateOverrides(model, overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Invalid connection edits.');
  for (const [from, row] of Object.entries(overrides)) {
    if (!model.transitions.has(from) || !row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Saved edit references an unknown sound.');
    for (const to of Object.keys(row)) if (!model.transitions.get(from).has(to)) throw new Error('Saved edit references an unknown connection.');
    distribution(model, from, 1, overrides);
  }
}

export function createWalker(model, { seed, temperature = 1, overrides = {} }) {
  const random = seededRandom(seed);
  let current = null;
  return {
    next() {
      current = current === null
        ? sample([...model.counts].map(([id,count]) => ({id, probability:count / model.total})), random)
        : sample(distribution(model, current, temperature, overrides), random);
      return {stateId:current, sound:model.states.get(current)};
    },
    update(settings) { temperature = settings.temperature ?? temperature; overrides = settings.overrides ?? overrides; },
    setCurrent(id) { if (!model.states.has(id)) throw new Error('Unknown restart sound.'); current = id; }
  };
}
