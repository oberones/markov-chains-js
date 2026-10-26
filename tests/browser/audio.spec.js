import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/audio-test', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><h1>Audio test surface</h1></body></html>' }));
  await page.goto('/audio-test');
});

test('every preset renders actual audible stereo PCM with finite samples', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { renderWav } = await import('/src/audio/export.js');
    const { PRESETS } = await import('/src/audio/synth.js');
    const clip = { events: [
      { stateId: 'rest', sound: { pitches: [], duration: { n: 1, d: 4 }, labels: [] } },
      { stateId: 'chord', sound: { pitches: [60, 64, 67], duration: { n: 1, d: 1 }, labels: [] } },
    ] };
    const result = [];
    for (const preset of Object.keys(PRESETS)) {
      const wav = await renderWav(clip, { tempo: 120, preset, volume: 0.65 });
      const view = new DataView(wav);
      let energy = 0, initialEnergy = 0, stereoDifference = 0, peak = 0;
      for (let offset = 44; offset < wav.byteLength; offset += 4) {
        const left = view.getInt16(offset, true) / 32768;
        const right = view.getInt16(offset + 2, true) / 32768;
        energy += left * left + right * right;
        stereoDifference += Math.abs(left - right);
        peak = Math.max(peak, Math.abs(left), Math.abs(right));
        if ((offset - 44) / 4 < 4410) initialEnergy += left * left + right * right;
      }
      result.push({ preset, energy, initialEnergy, stereoDifference, peak, frames: (wav.byteLength - 44) / 4, channels: view.getUint16(22, true) });
    }
    return result;
  });
  expect(results).toHaveLength(5);
  for (const result of results) {
    expect(result.energy).toBeGreaterThan(5);
    expect(result.initialEnergy).toBe(0);
    expect(result.stereoDifference).toBeGreaterThan(1);
    expect(result.peak).toBeGreaterThan(0.01);
    expect(result.peak).toBeLessThanOrEqual(1);
    expect(result.channels).toBe(2);
    expect(result.frames).toBe(Math.ceil((0.625 + 1.05) * 44100));
  }
});

test('WAV uses the same graph as playback and preserves a long held note', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { renderWav } = await import('/src/audio/export.js');
    const { createSynth } = await import('/src/audio/synth.js');
    const sound = { pitches: [60], duration: { n: 8, d: 1 }, labels: [] };
    const settings = { tempo: 120, preset: 'warm', volume: 0.5 };
    const wav = await renderWav({ events: [{ stateId: 'long', sound }] }, settings);
    const view = new DataView(wav);
    const context = new OfflineAudioContext(2, (wav.byteLength - 44) / 4, 44100);
    const synth = createSynth(context, settings);
    synth.scheduleSound(sound, 0, settings);
    const expected = await context.startRendering();
    let maxDifference = 0, heldEnergy = 0, centeredDifference = 0;
    for (let frame = 0; frame < expected.length; frame++) {
      const left = view.getInt16(44 + frame * 4, true) / 32768;
      const right = view.getInt16(46 + frame * 4, true) / 32768;
      maxDifference = Math.max(maxDifference, Math.abs(left - expected.getChannelData(0)[frame]));
      centeredDifference += Math.abs(left - right);
      if (frame > 3 * 44100 && frame < 3.5 * 44100) heldEnergy += left * left;
    }
    synth.dispose();
    return { maxDifference, heldEnergy, centeredDifference };
  });
  expect(result.maxDifference).toBeLessThan(0.0001);
  expect(result.heldEnergy).toBeGreaterThan(1);
  expect(result.centeredDifference).toBe(0);
});

test('actual AudioContext starts on interaction, freezes heard events, resumes and stops cleanly', async ({ page }) => {
  await page.evaluate(async () => {
    const { createTransport } = await import('/src/audio/transport.js');
    let index = 0;
    window.audioTest = { heard: [], completed: [], errors: [], resumed: [] };
    const value = window.audioTest;
    value.transport = createTransport({
      tempo: 240,
      getNextEvent: () => ({ stateId: `e${++index}`, sound: { pitches: [60 + index % 5], duration: { n: 1, d: 4 }, labels: [] } }),
      onEvent: (event) => value.heard.push(event.stateId),
      onComplete: (event) => value.completed.push(event.stateId),
      onError: (error) => value.errors.push(error.message),
      onResumeFromState: (id) => { value.resumed.push(id); index = Number(id.slice(1)); },
    });
    const button = document.createElement('button');
    button.id = 'audio-test-start';
    button.textContent = 'Start audio test';
    button.onclick = () => value.transport.start();
    document.body.prepend(button);
  });
  await page.locator('#audio-test-start').click();
  await page.waitForFunction(() => window.audioTest.completed.length >= 3);
  const captured = await page.evaluate(() => {
    const value = window.audioTest;
    const before = [...value.completed];
    const clip = value.transport.freeze(2);
    return { before, clip: clip.events.map((event) => event.stateId) };
  });
  expect(captured.clip).toEqual(captured.before.slice(-2));
  await page.waitForFunction(() => window.audioTest.transport.getStatus().mode === 'frozen');
  await page.evaluate(() => window.audioTest.transport.unfreeze());
  await page.waitForFunction(() => window.audioTest.transport.getStatus().mode === 'live');
  const result = await page.evaluate(() => {
    const value = window.audioTest;
    value.transport.stop();
    return { status: value.transport.getStatus(), errors: value.errors, resumed: value.resumed };
  });
  expect(result.status.isRunning).toBe(false);
  expect(result.status.mode).toBe('stopped');
  expect(result.errors).toEqual([]);
  expect(result.resumed).toHaveLength(1);
});

test('wide imported chords preserve all 128 pitches while release overlap stays bounded', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createSynth } = await import('/src/audio/synth.js');
    const context = new OfflineAudioContext(2, 44100, 44100);
    const original = context.createOscillator.bind(context);
    let oscillators = 0;
    const lifetimes = [];
    context.createOscillator = () => {
      oscillators++;
      const node = original();
      const lifetime = {};
      const start = node.start.bind(node);
      const stop = node.stop.bind(node);
      node.start = (when) => { lifetime.start = when; return start(when); };
      node.stop = (when) => { lifetime.end = when; return stop(when); };
      lifetimes.push(lifetime);
      return node;
    };
    const synth = createSynth(context, { tempo: 240, preset: 'warm', volume: 0.5 });
    const sound = { pitches: Array.from({ length: 128 }, (_, index) => index), duration: { n: 1, d: 4 }, labels: [] };
    for (let index = 0; index < 4; index++) synth.scheduleSound(sound, index / 16, { tempo: 240 });
    const buffer = await context.startRendering();
    const samples = buffer.getChannelData(0);
    let energy = 0;
    let finite = true;
    samples.forEach((sample) => { energy += sample * sample; finite &&= Number.isFinite(sample); });
    let active = 0, maxActive = 0;
    lifetimes.flatMap(({ start, end }) => [[start, 1], [end, -1]])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .forEach(([, change]) => { active += change; maxActive = Math.max(maxActive, active); });
    synth.dispose();
    return { oscillators, maxActive, finite, energy };
  });
  expect(result.oscillators).toBe(128 * 3 * 4);
  expect(result.maxActive).toBeLessThanOrEqual(256 * 3);
  expect(result.finite).toBe(true);
  expect(result.energy).toBeGreaterThan(1);
});
