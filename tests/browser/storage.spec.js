import { test, expect } from '@playwright/test';

test('named IndexedDB saves survive reload, preserve duplicates, and delete independently', async ({ page }) => {
  await page.goto('/');
  const ids = await page.evaluate(async () => {
    const { saveToy } = await import('/src/storage/index.js');
    const sound = { pitches: [60, 64, 67], duration: { n: 3, d: 2 }, labels: ['C4', 'E4', 'G4'] };
    const toy = {
      version: 1, name: 'Same name', savedAt: new Date().toISOString(),
      source: { name: 'Local test', events: [sound], warnings: [] }, seed: 'library-test', overrides: {},
      controls: { tempo: 96, preset: 'glassy', temperature: 1.5, volume: 0.4, freezeCount: 8 },
      clip: { events: [{ stateId: JSON.stringify([[60, 64, 67], 3, 2]), sound }] },
    };
    return [await saveToy(toy), await saveToy(toy)];
  });
  expect(ids[0]).not.toBe(ids[1]);
  await page.reload();
  const result = await page.evaluate(async ([first, second]) => {
    const { listToys, loadToy, deleteToy } = await import('/src/storage/index.js');
    const before = await listToys();
    const loaded = await loadToy(first);
    await deleteToy(first);
    const after = await listToys();
    let missingMessage;
    try { await loadToy(first); } catch (error) { missingMessage = error.message; }
    await deleteToy(first);
    await deleteToy(second);
    return { before, after, loaded, missingMessage, empty: await listToys() };
  }, ids);
  expect(result.before).toHaveLength(2);
  expect(result.before.every((item) => item.name === 'Same name')).toBe(true);
  expect(result.loaded.seed).toBe('library-test');
  expect(result.loaded.controls.preset).toBe('glassy');
  expect(result.loaded.clip.events[0].sound.duration).toEqual({ n: 3, d: 2 });
  expect(result.loaded).not.toHaveProperty('playing');
  expect(result.after).toHaveLength(1);
  expect(result.after[0].id).toBe(ids[1]);
  expect(result.missingMessage).toContain('no longer');
  expect(result.empty).toEqual([]);
});

test('portable toys still work when the browser library is disabled', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
    const { listToys, encodeToy, decodeToy } = await import('/src/storage/index.js');
    let message;
    try { await listToys(); } catch (error) { message = error.message; }
    const toy = {
      version: 1, name: 'Portable', savedAt: new Date().toISOString(),
      source: { name: 'Silence', events: [{ pitches: [], duration: { n: 1, d: 1 }, labels: [] }], warnings: [] },
      seed: 'portable', overrides: {},
      controls: { tempo: 96, preset: 'warm', temperature: 1, volume: 0.5, freezeCount: 16 }, clip: null,
    };
    return { message, reopened: decodeToy(encodeToy(toy)) };
  });
  expect(result.message).toContain('portable JSON');
  expect(result.reopened.name).toBe('Portable');
});
