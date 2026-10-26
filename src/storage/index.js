import { soundKey } from '../core/music.js';
import { train } from '../core/model.js';

/**
 * Portable, versioned toys and the browser-local named library.
 *
 * A saved toy contains normalized source sounds rather than the uploaded score.
 * Playback is deliberately absent from the format: callers always reopen paused.
 * All public writes and reads validate and copy data before exposing it.
 *
 * @typedef {{pitches:number[], duration:{n:number,d:number}, labels:string[]}} SoundObject
 * @typedef {{events:{stateId:string,sound:SoundObject}[]}} FrozenClip
 * @typedef {{version:1,name:string,savedAt:string,
 * source:{name:string,events:SoundObject[],warnings:string[]},seed:string,
 * overrides:Record<string,Record<string,number>>,
 * controls:{tempo:number,preset:string,temperature:number,volume:number,freezeCount:number},
 * clip:FrozenClip|null}} SavedToy
 */

export const SAVED_TOY_VERSION = 1;
export const MAX_TOY_BYTES = 5 * 1024 * 1024;
const DATABASE_NAME = 'markov-playground';
const STORE_NAME = 'toys';
const PRESETS = new Set(['warm', 'glassy', 'organ', 'dark', 'shimmer']);

function fail(message) {
  throw new Error(`Cannot open this toy: ${message}`);
}

function object(value, location) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${location} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${location} must contain plain data.`);
  }
  return value;
}

function string(value, location, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim())) {
    fail(`${location} must be ${allowEmpty ? 'text' : 'nonempty text'} of at most ${maximum} characters.`);
  }
  return value;
}

function number(value, location, minimum, maximum, integer = false) {
  if (!Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isSafeInteger(value))) {
    fail(`${location} must be ${integer ? 'an integer' : 'a number'} from ${minimum} to ${maximum}.`);
  }
  return value;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function sound(value, location) {
  object(value, location);
  if (!Array.isArray(value.pitches) || value.pitches.length > 128) {
    fail(`${location} must contain at most 128 pitches.`);
  }
  const pitches = [...new Set(value.pitches.map((pitch) => number(pitch, `${location} pitch`, 0, 127, true)))].sort((a, b) => a - b);
  object(value.duration, `${location} duration`);
  const n = number(value.duration.n, `${location} duration numerator`, 1, 1_000_000_000, true);
  const d = number(value.duration.d, `${location} duration denominator`, 1, 1_000_000_000, true);
  const divisor = gcd(n, d);
  if (!Array.isArray(value.labels) || value.labels.length > 128) {
    fail(`${location} labels must be a list of at most 128 names.`);
  }
  let labels = value.labels.map((label) => string(label, `${location} label`, 80, true));
  if (labels.length === value.pitches.length) {
    const spellingByPitch = new Map(value.pitches.map((pitch, index) => [pitch, labels[index]]));
    labels = pitches.map((pitch) => spellingByPitch.get(pitch));
  }
  return { pitches, duration: { n: n / divisor, d: d / divisor }, labels };
}

function trainingEdges(events) {
  try {
    const model = train(events);
    return { states: model.states, edges: model.transitions };
  } catch (error) {
    fail(error.message);
  }
}

/** Validate a version-1 toy and return an independent, canonical copy. */
export function validateToy(value) {
  object(value, 'The toy');
  if (value.version !== SAVED_TOY_VERSION) {
    fail(`saved-toy version ${String(value.version)} is unsupported; this app reads version ${SAVED_TOY_VERSION}.`);
  }
  const name = string(value.name, 'The name', 120);
  const savedAt = string(value.savedAt, 'The save date', 40);
  if (!Number.isFinite(Date.parse(savedAt)) || !/^\d{4}-\d{2}-\d{2}T/.test(savedAt)) fail('the save date is invalid.');
  const seed = string(value.seed, 'The journey seed', 256);
  object(value.source, 'The source');
  const sourceName = string(value.source.name, 'The source name', 200);
  if (!Array.isArray(value.source.events) || value.source.events.length < 1 || value.source.events.length > 4096) {
    fail('the source must contain from 1 to 4,096 sound objects.');
  }
  const events = value.source.events.map((entry, index) => sound(entry, `Source sound ${index + 1}`));
  if (!Array.isArray(value.source.warnings) || value.source.warnings.length > 100) {
    fail('source warnings must be a list of at most 100 messages.');
  }
  const warnings = value.source.warnings.map((warning) => string(warning, 'A source warning', 2000, true));
  const { states, edges } = trainingEdges(events);

  object(value.overrides, 'Probability edits');
  const overrides = Object.create(null);
  for (const [from, values] of Object.entries(value.overrides)) {
    const learned = edges.get(from);
    if (!learned) fail('a probability edit refers to an unknown source state.');
    object(values, 'Probability edits for a state');
    const row = Object.create(null);
    for (const [to, weight] of Object.entries(values)) {
      if (!learned.has(to)) fail('a probability edit refers to a connection absent from the source.');
      row[to] = number(weight, 'A connection weight', 0, 1_000_000);
    }
    if (![...learned].some(([to, weight]) => (row[to] ?? weight) > 0)) {
      fail('every state needs at least one positive outgoing connection.');
    }
    overrides[from] = row;
  }

  object(value.controls, 'The controls');
  const controls = {
    tempo: number(value.controls.tempo, 'Speed', 30, 240),
    preset: value.controls.preset,
    temperature: number(value.controls.temperature, 'Surprise', 0.5, 2),
    volume: number(value.controls.volume, 'Volume', 0, 1),
    freezeCount: value.controls.freezeCount,
  };
  if (!PRESETS.has(controls.preset)) fail('the sound preset is unknown.');
  if (![8, 16, 32].includes(controls.freezeCount)) fail('freeze length must be 8, 16, or 32 sounds.');

  let clip = null;
  if (value.clip !== null) {
    object(value.clip, 'The frozen phrase');
    if (!Array.isArray(value.clip.events) || value.clip.events.length < 1 || value.clip.events.length > 32) {
      fail('a frozen phrase must contain from 1 to 32 sound objects.');
    }
    clip = { events: value.clip.events.map((event, index) => {
      object(event, `Frozen sound ${index + 1}`);
      const normalized = sound(event.sound, `Frozen sound ${index + 1}`);
      if (event.stateId !== soundKey(normalized) || !states.has(event.stateId)) {
        fail('a frozen sound does not match a state in this toy.');
      }
      return { stateId: event.stateId, sound: normalized };
    }) };
  }
  return { version: SAVED_TOY_VERSION, name, savedAt, source: { name: sourceName, events, warnings }, seed, overrides, controls, clip };
}

/** Serialize a validated portable toy. No uploaded score data is required. */
export function encodeToy(toy) {
  const serialized = JSON.stringify(validateToy(toy), null, 2);
  if (new TextEncoder().encode(serialized).byteLength > MAX_TOY_BYTES) fail('the saved toy exceeds 5 MiB.');
  return serialized;
}

/** Parse portable JSON without evaluating code or trusting embedded paths. */
export function decodeToy(serialized) {
  if (typeof serialized !== 'string') fail('choose a JSON text file.');
  if (new TextEncoder().encode(serialized).byteLength > MAX_TOY_BYTES) fail('the saved toy exceeds 5 MiB.');
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    fail('the file is not valid JSON.');
  }
  return validateToy(parsed);
}

function libraryError(error) {
  if (error?.name === 'QuotaExceededError') return new Error('Your browser library is full. Download a JSON toy or delete an older library save.');
  return new Error('The browser library is unavailable. You can still save and open portable JSON toys.', { cause: error });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(libraryError());
      return;
    }
    let request;
    try {
      request = globalThis.indexedDB.open(DATABASE_NAME, 1);
    } catch (error) {
      reject(libraryError(error));
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    let blocked = false;
    request.onerror = () => reject(libraryError(request.error));
    request.onblocked = () => {
      blocked = true;
      reject(new Error('The browser library is waiting for another tab. Close older Markov Playground tabs and try again.'));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (blocked) {
        database.close();
        return;
      }
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

async function transaction(mode, operation) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      let result;
      let task;
      try {
        task = database.transaction(STORE_NAME, mode);
        const request = operation(task.objectStore(STORE_NAME));
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(libraryError(request.error));
      } catch (error) {
        reject(libraryError(error));
        return;
      }
      task.oncomplete = () => resolve(result);
      task.onerror = () => reject(libraryError(task.error));
      task.onabort = () => reject(libraryError(task.error));
    });
  } finally {
    database.close();
  }
}

/** Add a named library snapshot, returning a unique id independent of its name. */
export async function saveToy(toy) {
  const normalized = decodeToy(encodeToy(toy));
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  await transaction('readwrite', (store) => store.add({ id, toy: normalized }));
  return id;
}

/** List newest snapshots first without loading source material into the UI. */
export async function listToys() {
  const records = await transaction('readonly', (store) => store.getAll());
  return records.map(({ id, toy }) => ({ id, name: toy.name, savedAt: toy.savedAt }))
    .sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt) || a.name.localeCompare(b.name));
}

/** Load and revalidate a library snapshot; callers should restore playback paused. */
export async function loadToy(id) {
  const record = await transaction('readonly', (store) => store.get(id));
  if (!record) throw new Error('This toy is no longer in the browser library.');
  return validateToy(record.toy);
}

/** Delete one library snapshot. A missing id is already deleted. */
export async function deleteToy(id) {
  await transaction('readwrite', (store) => store.delete(id));
}
