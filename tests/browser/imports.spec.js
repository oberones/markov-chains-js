import { test, expect } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';

const score = measures => `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Test piano</part-name></score-part></part-list><part id="P1">${measures}</part></score-partwise>`;
const measure = body => `<measure number="1">${body}</measure>`;
const attrs = (divisions = 12, extra = '') => `<attributes><divisions>${divisions}</divisions>${extra}</attributes>`;
const note = (step = 'C', duration = 12, extra = '', pitchExtra = '') => `<note>${extra.includes('<chord/>') ? '<chord/>' : ''}<pitch><step>${step}</step>${pitchExtra}<octave>4</octave></pitch><duration>${duration}</duration>${extra.replace('<chord/>', '')}</note>`;
const encoded = xml => [...new TextEncoder().encode(xml)];

async function importScore(page, xml, name = 'test.musicxml', part = 'P1') {
  await page.goto('/');
  return page.evaluate(async ({ data, name, part }) => {
    const { inspectBytes } = await import('/src/import/index.js');
    try {
      const inspected = await inspectBytes(name, Uint8Array.from(data));
      return { parts: inspected.parts, ...inspected.readPart(part) };
    } catch (error) { return { error: error.message }; }
  }, { data: typeof xml === 'string' ? encoded(xml) : [...xml], name, part });
}

test('MusicXML durations use divisions, not type, with exact dots and tuplets', async ({ page }) => {
  const xml = score(measure(attrs() + note('C', 18, '<type>quarter</type><dot/>') + note('D', 4, '<type>eighth</type>') + note('E', 4) + note('F', 4)));
  const result = await importScore(page, xml);
  expect(result.error).toBeUndefined();
  expect(result.events.map(e => e.duration)).toEqual([{ n: 3, d: 2 }, { n: 1, d: 3 }, { n: 1, d: 3 }, { n: 1, d: 3 }]);
  expect(result.tempo).toBe(96);
});

test('MusicXML two quarter rests stay distinct from one half rest', async ({ page }) => {
  const quarters = score(measure(attrs() + '<note><rest/><duration>12</duration></note><note><rest/><duration>12</duration></note>'));
  const half = score(measure(attrs() + '<note><rest/><duration>24</duration></note>'));
  const two = await importScore(page, quarters);
  const one = await importScore(page, half);
  expect(two.events.map(event => event.duration)).toEqual([{ n: 1, d: 1 }, { n: 1, d: 1 }]);
  expect(one.events.map(event => event.duration)).toEqual([{ n: 2, d: 1 }]);
  expect(two.events.every(event => !event.pitches.length)).toBe(true);
});

test('MusicXML rests in another voice do not divide a held sounding note', async ({ page }) => {
  const xml = score(measure(attrs() + note('C', 24, '<voice>1</voice>') + '<backup><duration>24</duration></backup><note><rest/><duration>12</duration><voice>2</voice></note><note><rest/><duration>12</duration><voice>2</voice></note>'));
  const result = await importScore(page, xml);
  expect(result.events).toHaveLength(1);
  expect(result.events[0].pitches).toEqual([60]);
  expect(result.events[0].duration).toEqual({ n: 2, d: 1 });
  expect(result.warnings.join(' ')).not.toContain('chord snapshots');
});

test('MusicXML parses backup, forward, unequal chord tones and snapshot warning', async ({ page }) => {
  const xml = score(measure(attrs() + note('C', 48, '<voice>1</voice>') + '<backup><duration>48</duration></backup><forward><duration>12</duration></forward>' + note('E', 12, '<voice>2</voice>') + note('G', 6, '<chord/><voice>2</voice>') + '<forward><duration>24</duration></forward>'));
  const result = await importScore(page, xml);
  expect(result.events.map(e => e.pitches)).toEqual([[60], [60, 64, 67], [60, 64], [60]]);
  expect(result.events.map(e => e.duration)).toEqual([{ n: 1, d: 1 }, { n: 1, d: 2 }, { n: 1, d: 2 }, { n: 2, d: 1 }]);
  expect(result.warnings.join(' ')).toContain('chord snapshots');
});

test('MusicXML merges sounding ties across measures but retains adjacent attacks', async ({ page }) => {
  const xml = score(measure(attrs() + note('C', 12, '<tie type="start"/><voice>1</voice>')) + measure(note('C', 12, '<tie type="stop"/><voice>1</voice>') + note('C', 12, '<voice>1</voice>')));
  const result = await importScore(page, xml);
  expect(result.events.map(e => e.duration)).toEqual([{ n: 2, d: 1 }, { n: 1, d: 1 }]);
  expect(result.events.map(e => e.pitches)).toEqual([[60], [60]]);
});

test('MusicXML keeps a tied voice sounding when it crosses staves', async ({ page }) => {
  const xml = score(measure(attrs() + note('C', 12, '<tie type="start"/><voice>1</voice><staff>1</staff>')) + measure(note('C', 12, '<tie type="stop"/><voice>1</voice><staff>2</staff>')));
  const result = await importScore(page, xml);
  expect(result.events).toHaveLength(1);
  expect(result.events[0].duration).toEqual({ n: 2, d: 1 });
  expect(result.warnings.join(' ')).not.toMatch(/unmatched tie|past this excerpt/);
});

test('MusicXML uses alter for sounding pitch, transposes and preserves spelling', async ({ page }) => {
  const xml = score(measure(attrs(1, '<key><fifths>-3</fifths></key><transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose>') + note('B', 1, '<accidental>natural</accidental>', '<alter>-1</alter>')));
  const result = await importScore(page, xml);
  expect(result.events[0].pitches).toEqual([68]);
  expect(result.events[0].labels[0]).toContain('B♭4');
  expect(result.warnings.join(' ')).toContain('transposition');
});

test('an all-staff transposition change replaces previous staff-specific shifts', async ({ page }) => {
  const xml = score(measure(attrs(12, '<transpose number="2"><chromatic>0</chromatic><octave-change>-1</octave-change></transpose>') + note('C', 12, '<staff>2</staff>')) + measure('<attributes><transpose><chromatic>0</chromatic></transpose></attributes>' + note('C', 12, '<staff>2</staff>')));
  const result = await importScore(page, xml);
  expect(result.events.map(event => event.pitches)).toEqual([[48], [60]]);
  expect(result.warnings.join(' ')).toContain('transposition was applied');
});

test('MusicXML performance offsets are explicitly ignored without changing score timing', async ({ page }) => {
  const xml = score(measure(attrs() + note('C', 12).replace('<note>', '<note attack="2" release="-3">')));
  const result = await importScore(page, xml);
  expect(result.events[0].duration).toEqual({ n: 1, d: 1 });
  expect(result.warnings.join(' ')).toContain('Performance attack/release offsets are ignored');
});

test('MusicXML divisions changes remain exact, including a pickup measure', async ({ page }) => {
  const xml = score(`<measure number="0" implicit="yes">${attrs(2)}${note('C', 1)}</measure>` + measure(attrs(3) + note('D', 1) + '<note><rest/><duration>2</duration></note>'));
  const result = await importScore(page, xml);
  expect(result.events.map(e => e.duration)).toEqual([{ n: 1, d: 2 }, { n: 1, d: 3 }, { n: 2, d: 3 }]);
  expect(result.events.at(-1).pitches).toEqual([]);
});

test('MusicXML first tempo, clamp and unsupported performance features are disclosed', async ({ page }) => {
  const xml = score(measure(attrs() + '<direction><sound tempo="300"/></direction><direction><sound tempo="90"/></direction><note><grace/><pitch><step>D</step><octave>4</octave></pitch></note>' + note('C', 12) + '<barline><repeat direction="backward"/></barline>'));
  const result = await importScore(page, xml);
  expect(result.tempo).toBe(240);
  expect(result.events).toHaveLength(1);
  expect(result.warnings.join(' ')).toMatch(/Tempo changes/);
  expect(result.warnings.join(' ')).toMatch(/Grace notes/);
  expect(result.warnings.join(' ')).toMatch(/read once/);
});

test('MusicXML metronome beat units and direct sound tempos follow document order', async ({ page }) => {
  let xml = score(measure(attrs() + '<direction><direction-type><metronome><beat-unit>quarter</beat-unit><beat-unit-dot/><per-minute>60</per-minute></metronome></direction-type></direction>' + note()));
  expect((await importScore(page, xml)).tempo).toBe(90);
  xml = score(measure(attrs() + '<sound tempo="72"/><direction><sound tempo="120"/></direction>' + note()));
  expect((await importScore(page, xml)).tempo).toBe(72);
});

test('MusicXML rejects microtones, unpitched notes and malformed timing', async ({ page }) => {
  let result = await importScore(page, score(measure(attrs() + note('C', 12, '', '<alter>0.5</alter>'))));
  expect(result.error).toMatch(/Microtonal/);
  result = await importScore(page, score(measure(attrs() + '<note><unpitched/><duration>12</duration></note>')));
  expect(result.error).toMatch(/percussion/);
  result = await importScore(page, score(measure(attrs() + '<backup><duration>12</duration></backup>' + note())));
  expect(result.error).toMatch(/before the start/);
  result = await importScore(page, score(measure(note())));
  expect(result.error).toMatch(/divisions/);
});

test('MusicXML rejects entities, malformed XML and timewise scores', async ({ page }) => {
  expect((await importScore(page, '<score-partwise>')).error).toMatch(/malformed/);
  expect((await importScore(page, '<score-timewise/>')).error).toMatch(/score-partwise/);
  expect((await importScore(page, '<!DOCTYPE score-partwise [<!ENTITY x "abc">]><score-partwise/>')).error).toMatch(/custom entities/);
});

test('MusicXML supports namespaces and independent selected parts', async ({ page }) => {
  const xml = `<score-partwise xmlns="http://www.musicxml.org/ns/musicxml"><part-list><score-part id="P1"><part-name>Flute</part-name></score-part><score-part id="P2"><part-name>Cello</part-name></score-part></part-list><part id="P1">${measure(attrs() + note('C'))}</part><part id="P2">${measure(attrs() + note('G'))}</part></score-partwise>`;
  const result = await importScore(page, xml, 'test.xml', 'P2');
  expect(result.parts).toEqual([{ id: 'P1', name: 'Flute' }, { id: 'P2', name: 'Cello' }]);
  expect(result.events[0].pitches).toEqual([67]);
});

test('MXL follows its container rootfile and decodes the selected score', async ({ page }) => {
  const archive = zipSync({
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="scores/score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>'),
    'scores/score.musicxml': strToU8(score(measure(attrs() + note('E')))),
    'thumbnail.png': new Uint8Array([1, 2, 3])
  });
  const result = await importScore(page, archive, 'song.mxl');
  expect(result.error).toBeUndefined();
  expect(result.events[0].pitches).toEqual([64]);
});

test('MXL rejects absent roots, truncated archives and excessive expansion', async ({ page }) => {
  const missing = zipSync({ 'a.xml': strToU8('<test/>') });
  expect((await importScore(page, missing, 'song.mxl')).error).toMatch(/container.xml/);
  expect((await importScore(page, missing.subarray(0, missing.length - 10), 'song.mxl')).error).toMatch(/incomplete/);
  const oversized = zipSync({ 'large.xml': new Uint8Array(10 * 1024 * 1024 + 1).fill(65) });
  expect((await importScore(page, oversized, 'song.mxl')).error).toMatch(/10 MiB/);
  const expanded = zipSync({ 'a.bin': new Uint8Array(11 * 1024 * 1024), 'b.bin': new Uint8Array(11 * 1024 * 1024) });
  expect((await importScore(page, expanded, 'song.mxl')).error).toMatch(/20 MiB/);
});

test('MXL actual expansion is capped even when its local size metadata is false', async ({ page }) => {
  const archive = zipSync({ 'large.xml': new Uint8Array(10 * 1024 * 1024 + 1).fill(65) });
  new DataView(archive.buffer, archive.byteOffset, archive.byteLength).setUint32(22, 1, true);
  expect((await importScore(page, archive, 'song.mxl')).error).toMatch(/10 MiB/);
});
