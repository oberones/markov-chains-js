import { add, compare, fraction, noteName } from '../core/music.js';
import { decimal, LIMITS, maxTime, normalizeTempo, normalizeTimeline, ratio, warning, ZERO } from './normalize.js';

const children = (node, name) => [...(node?.children || [])].filter(child => child.localName === name);
const child = (node, name) => children(node, name)[0];
const text = (node, name) => child(node, name)?.textContent.trim();
const descendants = (node, name) => [...node.getElementsByTagNameNS('*', name)];

export function parseXml(source) {
  if (typeof DOMParser === 'undefined') throw new Error('MusicXML import requires a browser.');
  // Ordinary external MusicXML DOCTYPE declarations are harmless in DOMParser;
  // reject custom entities/internal subsets instead of processing user expansion.
  if (/<!ENTITY\b/i.test(source) || /<!DOCTYPE[^>]*\[/i.test(source)) throw new Error('XML documents with custom entities are not supported.');
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  if (doc.documentElement.localName === 'parsererror' || descendants(doc, 'parsererror').length) throw new Error('This MusicXML document is malformed.');
  return doc;
}

const integer = (value, label) => {
  if (!/^[+-]?\d+$/.test(String(value ?? '').trim())) throw new Error(`${label} must be a whole number.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} is too large.`);
  return number;
};

function getPitch(note, transpose) {
  if (child(note, 'unpitched')) throw new Error('Unpitched/percussion MusicXML notes are not supported. Select a pitched part.');
  const pitch = child(note, 'pitch');
  if (!pitch) throw new Error('A MusicXML note is missing its pitch or rest.');
  const step = text(pitch, 'step');
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[step];
  if (base == null) throw new Error('A MusicXML note has an invalid pitch step.');
  const octave = integer(text(pitch, 'octave'), 'Pitch octave');
  const alteration = decimal(text(pitch, 'alter') || '0', 'Pitch alteration');
  if (alteration.d !== 1) throw new Error('Microtonal MusicXML pitches are not supported. Use whole semitone pitches.');
  if (Math.abs(alteration.n) > 4) throw new Error('This MusicXML pitch alteration is unsupported.');
  const sounding = 12 * (octave + 1) + base + alteration.n + transpose;
  if (sounding < 0 || sounding > 127) throw new Error('A transposed pitch falls outside MIDI notes 0–127.');
  const accidental = alteration.n < 0 ? '♭'.repeat(-alteration.n) : '♯'.repeat(alteration.n);
  const spelling = `${step}${accidental}${octave}`;
  return { pitch: sounding, label: transpose ? `${spelling} → ${noteName(sounding)}` : spelling };
}

function readMusicXmlPart(part, scorePart) {
  const warnings = [];
  const noteElements = descendants(part, 'note');
  if (noteElements.length > LIMITS.notes) throw new Error('This part has more than 10,000 notes. Import a shorter excerpt.');
  if (scorePart && descendants(scorePart, 'midi-channel').some(channel => Number(channel.textContent) === 10)) throw new Error('This part is assigned to percussion channel 10. Select a pitched part.');
  if (descendants(part, 'repeat').length || descendants(part, 'ending').length || descendants(part, 'segno').length || descendants(part, 'coda').length || descendants(part, 'sound').some(sound => ['dacapo', 'dalsegno', 'tocoda', 'fine'].some(attribute => sound.hasAttribute(attribute)))) warning(warnings, 'Repeats and score jumps are not expanded; the written measures are read once.');
  if (descendants(part, 'dynamics').length || noteElements.some(note => note.hasAttribute('dynamics'))) warning(warnings, 'Dynamics are not modeled; playback uses a consistent level.');
  if (descendants(part, 'pedal').length || descendants(part, 'ornaments').length || descendants(part, 'articulations').length) warning(warnings, 'Pedal, ornaments, and articulation markings are not modeled.');
  if (noteElements.some(note => note.hasAttribute('attack') || note.hasAttribute('release'))) warning(warnings, 'Performance attack/release offsets are ignored; the written note durations are used.');
  const tempoValues = [];
  for (const element of descendants(part, '*')) {
    if (element.localName === 'sound' && element.hasAttribute('tempo')) tempoValues.push(Number(element.getAttribute('tempo')));
    else if (element.localName === 'metronome') {
      const direction = element.parentElement?.parentElement;
      // The sound tempo is authoritative when the notation also shows a marking.
      if (!child(direction, 'sound')?.hasAttribute('tempo')) {
        const metronome = element;
        const units = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125 };
        let unit = units[text(metronome, 'beat-unit')];
        const bpm = Number(text(metronome, 'per-minute'));
        if (unit && Number.isFinite(bpm)) {
          const dots = children(metronome, 'beat-unit-dot').length;
          unit *= 2 - 0.5 ** dots;
          tempoValues.push(bpm * unit);
        }
      }
    }
  }
  if (tempoValues.length > 1) warning(warnings, 'Tempo changes are ignored; the first source tempo is used.');
  const tempo = normalizeTempo(tempoValues[0], warnings);
  let divisions = null;
  let measureStart = ZERO;
  let meter = null;
  let transpositionApplied = false;
  const transposeByStaff = new Map();
  const notes = [];
  const restBoundaries = [];
  const ties = new Map();
  const durationOf = (element) => {
    if (!divisions) throw new Error('MusicXML divisions must be declared before timed notes.');
    const duration = ratio(decimal(text(element, 'duration'), 'Note duration'), divisions);
    if (duration.n <= 0) throw new Error('MusicXML durations must be positive.');
    return duration;
  };
  for (const measure of children(part, 'measure')) {
    let cursor = ZERO;
    let extent = ZERO;
    let chordStart = null;
    for (const element of measure.children) {
      if (element.localName === 'attributes') {
        if (child(element, 'divisions')) {
          divisions = decimal(text(element, 'divisions'), 'MusicXML divisions');
          if (divisions.n <= 0) throw new Error('MusicXML divisions must be positive.');
        }
        for (const transposition of children(element, 'transpose')) {
          if (child(transposition, 'double')) throw new Error('Octave-doubled transposing instruments are not supported.');
          const chromatic = decimal(text(transposition, 'chromatic') || '0', 'Instrument transposition');
          if (chromatic.d !== 1) throw new Error('Microtonal instrument transposition is not supported.');
          const shift = chromatic.n + 12 * integer(text(transposition, 'octave-change') || '0', 'Octave transposition');
          const staff = transposition.getAttribute('number');
          // Without a staff number this replaces the transposition of all staves.
          if (!staff) transposeByStaff.clear();
          transposeByStaff.set(staff || '*', shift);
        }
        const time = child(element, 'time');
        if (time && !child(time, 'senza-misura')) {
          const beats = text(time, 'beats');
          const type = text(time, 'beat-type');
          if (beats && type) meter = fraction(beats.split('+').reduce((sum, item) => sum + integer(item, 'Time signature'), 0) * 4, integer(type, 'Time signature'));
        }
      } else if (element.localName === 'backup' || element.localName === 'forward') {
        const duration = durationOf(element);
        cursor = add(cursor, { n: duration.n * (element.localName === 'backup' ? -1 : 1), d: duration.d });
        if (compare(cursor, ZERO) < 0) throw new Error('A MusicXML backup moves before the start of its measure.');
        extent = maxTime(extent, cursor);
        chordStart = null;
      } else if (element.localName === 'note') {
        if (child(element, 'grace')) { warning(warnings, 'Grace notes are omitted.'); continue; }
        if (child(element, 'cue')) { warning(warnings, 'Cue notes are omitted.'); }
        const duration = durationOf(element);
        const isChord = !!child(element, 'chord');
        if (isChord && chordStart == null) throw new Error('A MusicXML chord tone has no preceding base note.');
        const start = isChord ? chordStart : cursor;
        if (!isChord) { chordStart = start; cursor = add(cursor, duration); }
        const end = add(start, duration);
        extent = maxTime(extent, maxTime(cursor, end));
        if (child(element, 'rest')) {
          restBoundaries.push(add(measureStart, start), add(measureStart, end));
          continue;
        }
        if (child(element, 'cue')) continue;
        const staff = text(element, 'staff') || '1';
        const voice = text(element, 'voice') || '1';
        const shift = transposeByStaff.get(staff) ?? transposeByStaff.get('*') ?? 0;
        if (shift) transpositionApplied = true;
        const pitched = getPitch(element, shift);
        const note = { ...pitched, voice, staff, start: add(measureStart, start), end: add(measureStart, end) };
        const key = JSON.stringify([voice, staff, pitched.pitch]);
        const tieTypes = children(element, 'tie').map(tie => tie.getAttribute('type'));
        let continuationKey = key;
        let continuation = tieTypes.includes('stop') ? ties.get(key) : null;
        if (tieTypes.includes('stop') && !continuation) {
          // A voice may cross staves. Only use a different staff when the
          // pitch, voice, and contiguous time identify exactly one open tie.
          const candidates = [...ties].filter(([, prior]) => prior.voice === voice && prior.pitch === pitched.pitch && compare(prior.end, note.start) === 0);
          if (candidates.length === 1) [continuationKey, continuation] = candidates[0];
        }
        let sounding = note;
        if (continuation && compare(continuation.end, note.start) === 0) {
          continuation.end = note.end;
          sounding = continuation;
        } else {
          if (tieTypes.includes('stop')) warning(warnings, 'An unmatched tie ending was treated as a new note.');
          notes.push(note);
        }
        ties.delete(continuationKey);
        ties.delete(key);
        if (tieTypes.includes('start')) ties.set(key, sounding);
      }
    }
    if (compare(extent, ZERO) === 0 && meter) extent = meter;
    measureStart = add(measureStart, extent);
  }
  if (ties.size) warning(warnings, 'A tie continues past this excerpt; its written duration was retained.');
  if (transpositionApplied) warning(warnings, 'Instrument transposition was applied to sounding pitches; labels retain the written spelling.');
  return { events: normalizeTimeline(notes, measureStart, warnings, restBoundaries), tempo, warnings };
}

export function inspectMusicXml(name, source) {
  const document = parseXml(source);
  const root = document.documentElement;
  if (root.localName !== 'score-partwise') throw new Error('Only score-partwise MusicXML is supported. Export an uncompressed or MXL partwise score.');
  const scoreParts = child(root, 'part-list') ? children(child(root, 'part-list'), 'score-part') : [];
  const sourceParts = children(root, 'part');
  const parts = sourceParts.map((part, index) => {
    const id = part.getAttribute('id') || `part:${index}`;
    const info = scoreParts.find(candidate => candidate.getAttribute('id') === id);
    return { id, name: text(info || part, 'part-name') || `Part ${index + 1}` };
  });
  if (!parts.length) throw new Error('This MusicXML score has no parts.');
  if (new Set(parts.map(part => part.id)).size !== parts.length) throw new Error('MusicXML part identifiers must be unique.');
  return {
    name, parts,
    readPart(id) {
      const index = parts.findIndex(part => part.id === id);
      if (index < 0) throw new Error('Select a part from this file.');
      return readMusicXmlPart(sourceParts[index], scoreParts.find(part => part.getAttribute('id') === id));
    }
  };
}
