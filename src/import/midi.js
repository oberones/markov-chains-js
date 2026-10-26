import { parseMidi } from 'midi-file';
import { fraction, noteName } from '../core/music.js';
import { LIMITS, normalizeTempo, normalizeTimeline, warning } from './normalize.js';

export function inspectMidi(name, bytes) {
  if (bytes.length < 14) throw new Error('This MIDI file is malformed or incomplete.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(4);
  if (headerLength < 6 || headerLength + 8 > bytes.length) throw new Error('This MIDI header is malformed or incomplete.');
  let offset = headerLength + 8;
  const trackCount = view.getUint16(10);
  for (let index = 0; index < trackCount; index++) {
    if (offset + 8 > bytes.length || view.getUint32(offset) !== 0x4d54726b) throw new Error('This MIDI file has a missing or incomplete track.');
    offset += 8 + view.getUint32(offset + 4);
    if (offset > bytes.length) throw new Error('This MIDI file has a truncated track.');
  }
  let midi;
  try { midi = parseMidi(bytes); } catch { throw new Error('This MIDI file is malformed or incomplete.'); }
  if (midi.header.format === 2) throw new Error('MIDI format 2 contains separate timelines. Export format 0 or 1 instead.');
  if (![0, 1].includes(midi.header.format)) throw new Error('Only MIDI format 0 and 1 are supported.');
  const ppq = midi.header.ticksPerBeat;
  if (!Number.isInteger(ppq) || ppq <= 0) throw new Error('SMPTE MIDI timing is not supported. Export a file with ticks per quarter note.');
  const tempos = [];
  midi.tracks.forEach(track => {
    let tick = 0;
    for (const event of track) {
      if (!Number.isSafeInteger(event.deltaTime) || event.deltaTime < 0) throw new Error('The MIDI timeline is invalid.');
      tick += event.deltaTime;
      if (!Number.isSafeInteger(tick)) throw new Error('The MIDI timeline is too long.');
      if (event.type === 'setTempo') tempos.push({ tick, value: 60000000 / event.microsecondsPerBeat });
    }
  });
  tempos.sort((a, b) => a.tick - b.tick);
  const parts = midi.tracks.flatMap((track, index) => track.some(e => e.type === 'noteOn' && e.velocity > 0) ? [{ id: `track:${index}`, name: track.find(e => e.type === 'trackName')?.text || `Track ${index + 1}` }] : []);
  if (!parts.length) throw new Error('This MIDI file has no tracks with pitched notes.');
  return {
    name, parts,
    readPart(id) {
      if (!parts.some(part => part.id === id)) throw new Error('Select a track from this file.');
      const track = midi.tracks[Number(id.split(':')[1])];
      const warnings = ['MIDI timing was snapped to 1/24 beat. Velocity and instrument changes are not modeled.'];
      if (tempos.length > 1) warning(warnings, 'Tempo changes are ignored; the first source tempo is used.');
      const tempo = normalizeTempo(tempos[0]?.value, warnings);
      const open = new Map();
      const notes = [];
      let tick = 0;
      let count = 0;
      let end = 0;
      const snap = t => Math.round(t * 24 / ppq);
      for (const event of track) {
        tick += event.deltaTime;
        if (event.type === 'controller' && event.controllerType === 64) warning(warnings, 'Sustain pedal is ignored; note-off timing determines duration.');
        if (event.type === 'pitchBend') warning(warnings, 'Pitch bend is ignored; only the written MIDI note numbers are used.');
        if (!['noteOn', 'noteOff'].includes(event.type)) continue;
        if (event.channel === 9) throw new Error('This track contains percussion on MIDI channel 10. Select a pitched track.');
        if (!Number.isInteger(event.noteNumber) || event.noteNumber < 0 || event.noteNumber > 127) throw new Error('The MIDI track contains an invalid pitch.');
        const key = `${event.channel}:${event.noteNumber}`;
        if (event.type === 'noteOn' && event.velocity > 0) {
          if (++count > LIMITS.notes) throw new Error('This track has more than 10,000 notes. Import a shorter excerpt.');
          if (!open.has(key)) open.set(key, []);
          if (open.get(key).length) warning(warnings, 'Overlapping attacks of the same MIDI pitch were paired with note-offs in arrival order.');
          open.get(key).push({ start: snap(tick), pitch: event.noteNumber });
        } else {
          const note = open.get(key)?.shift();
          if (!note) { warning(warnings, 'Unmatched MIDI note-off messages were ignored.'); continue; }
          const stop = Math.max(note.start + 1, snap(tick));
          if (snap(tick) <= note.start) warning(warnings, 'Notes shorter than the timing grid were extended to 1/24 beat.');
          end = Math.max(end, stop);
          notes.push({ pitch: note.pitch, label: noteName(note.pitch), start: fraction(note.start, 24), end: fraction(stop, 24) });
        }
      }
      if ([...open.values()].some(queue => queue.length)) throw new Error('This track has notes without matching note-off messages. Export a complete excerpt.');
      end = Math.max(end, snap(tick));
      const events = normalizeTimeline(notes, fraction(end, 24), warnings);
      return { events, tempo, warnings };
    }
  };
}
