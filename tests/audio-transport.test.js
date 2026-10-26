import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../src/audio/transport.js';

const event = (id, n = 1, d = 1, pitches = [60]) => ({ stateId: id, sound: { pitches, duration: { n, d }, labels: [] } });

function harness(overrides = {}) {
  const context = { currentTime: 0, state: 'running', async resume() { this.state = 'running'; } };
  const callbacks = { heard: [], completed: [], modes: [], errors: [], resumed: [] };
  const scheduled = [];
  const intervals = new Set();
  const delayed = [];
  let next = 0;
  let stopped = 0;
  let disposed = 0;
  const synth = {
    scheduleSound(sound, when, settings) {
      const item = { sound, when, settings: { ...settings }, cancelled: false };
      scheduled.push(item);
      return { cancel(at) { item.cancelled = true; item.cancelledAt = at; } };
    },
    update(settings) { this.settings = { ...settings }; },
    stop() { stopped++; }, dispose() { disposed++; },
  };
  const transport = createTransport({
    tempo: 120,
    contextFactory: () => context,
    synthFactory: () => synth,
    setIntervalFn: (fn) => { intervals.add(fn); return fn; },
    clearIntervalFn: (fn) => intervals.delete(fn),
    setTimeoutFn: (fn, ms) => delayed.push({ fn, at: context.currentTime + ms / 1000 }),
    getNextEvent: () => event(`e${++next}`),
    onEvent: (value, info) => callbacks.heard.push({ ...value, ...info }),
    onComplete: (value) => callbacks.completed.push(value),
    onMode: (mode) => callbacks.modes.push(mode),
    onError: (error) => callbacks.errors.push(error),
    onResumeFromState: (id) => callbacks.resumed.push(id),
    ...overrides,
  });
  function pulse(time) {
    context.currentTime = time;
    [...intervals].forEach((fn) => fn());
    for (let index = delayed.length - 1; index >= 0; index--) {
      if (delayed[index].at <= time) delayed.splice(index, 1)[0].fn();
    }
  }
  function advance(time) {
    while (context.currentTime + 0.025 < time - 1e-9) pulse(context.currentTime + 0.025);
    pulse(time);
  }
  return { transport, context, callbacks, scheduled, pulse, advance, intervals, cleanup: () => ({ stopped, disposed }) };
}

test('callbacks track audible starts and complete events, not the scheduling horizon', async () => {
  const h = harness();
  assert.equal(await h.transport.start(), true);
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.callbacks.heard.length, 0);
  h.advance(0.025);
  assert.equal(h.callbacks.heard[0].stateId, 'e1');
  assert.equal(h.callbacks.completed.length, 0);
  h.advance(0.525);
  assert.deepEqual(h.callbacks.completed.map((e) => e.stateId), ['e1']);
  assert.equal(h.callbacks.heard[1].stateId, 'e2');
  h.transport.stop();
  h.advance(0.7);
  assert.equal(h.intervals.size, 0);
  assert.deepEqual(h.cleanup(), { stopped: 1, disposed: 1 });
});

test('freeze copies only completed heard events and cancels already scheduled future notes', async () => {
  let next = 0;
  const h = harness({ getNextEvent: () => event(`e${++next}`, 1, 4) });
  await h.transport.start();
  assert.equal(h.transport.freeze(16), null);
  h.advance(0.24);
  assert.ok(h.scheduled.some((e) => Math.abs(e.when - 0.275) < 1e-9));
  const clip = h.transport.freeze(16);
  assert.deepEqual(clip.events.map((e) => e.stateId), ['e1']);
  assert.equal(h.transport.getStatus().mode, 'freezing');
  assert.ok(h.scheduled.some((e) => e.cancelled && Math.abs(e.when - 0.275) < 1e-9));
  h.advance(0.3);
  assert.equal(h.transport.getStatus().mode, 'frozen');
  assert.deepEqual(h.callbacks.heard.map((e) => e.stateId), ['e1', 'e2', 'e1']);
  clip.events[0].stateId = 'mutated';
  assert.equal(h.transport.getClip().events[0].stateId, 'e1');
});

test('unfreeze resumes from the boundary event before consuming another walker result', async () => {
  const calls = [];
  let next = 0;
  const h = harness({
    getNextEvent() { calls.push('next'); return event(`e${++next}`, 1, 4); },
    onResumeFromState(id) { calls.push(`resume:${id}`); next = Number(id.slice(1)); },
  });
  await h.transport.start();
  h.advance(0.24);
  h.transport.freeze(1);
  h.advance(0.31);
  calls.length = 0;
  h.transport.unfreeze();
  assert.equal(calls[0], 'resume:e1');
  assert.equal(calls[1], 'next');
  h.advance(0.42);
  assert.equal(h.transport.getStatus().mode, 'live');
  assert.equal(h.callbacks.heard.at(-1).stateId, 'e2');
  assert.equal(h.transport.getClip(), null);
});

test('saved clips start frozen, retain fractional beats and rests, and ignore walker', async () => {
  const h = harness({ getNextEvent: () => { throw new Error('Walker must not run'); } });
  h.transport.setClip({ events: [event('rest', 1, 3, []), event('chord', 2, 3, [60, 64, 67])] });
  await h.transport.start();
  h.advance(0.22);
  assert.equal(h.transport.getStatus().mode, 'frozen');
  assert.ok(Math.abs(h.scheduled[1].when - (0.025 + 1 / 6)) < 1e-9);
  assert.deepEqual(h.scheduled[0].sound.pitches, []);
  assert.deepEqual(h.scheduled[1].sound.pitches, [60, 64, 67]);
  assert.equal(h.callbacks.errors.length, 0);
});

test('tempo and preset changes apply to the unscheduled future without shortening a current note', async () => {
  const h = harness();
  await h.transport.start();
  h.advance(0.2);
  h.transport.update({ tempo: 240, preset: 'glassy', volume: 0.2 });
  h.advance(0.7);
  assert.equal(h.scheduled[0].settings.tempo, 120);
  assert.equal(h.scheduled[1].settings.tempo, 240);
  assert.equal(h.scheduled[1].settings.preset, 'glassy');
  assert.ok(Math.abs(h.scheduled[1].when - 0.525) < 1e-9);
  assert.ok(Math.abs(h.scheduled[2].when - 0.775) < 1e-9);
});

test('long timer stalls re-anchor without generating a catch-up burst; suspension pauses scheduling', async () => {
  const h = harness();
  await h.transport.start();
  h.context.state = 'suspended';
  h.pulse(5);
  assert.equal(h.scheduled.length, 1);
  h.context.state = 'running';
  h.pulse(10);
  assert.equal(h.scheduled.length, 2);
  assert.ok(h.scheduled[1].when >= 10.025);
  assert.equal(h.callbacks.errors.length, 0);
});

test('a finite preview drains its final event then stops and retains the release tail', async () => {
  let next = 0;
  const h = harness({ getNextEvent: () => next++ === 0 ? event('only') : null });
  await h.transport.start();
  h.advance(0.52);
  assert.equal(h.transport.getStatus().isRunning, true);
  h.advance(0.55);
  assert.equal(h.transport.getStatus().isRunning, false);
  assert.equal(h.callbacks.completed.length, 1);
  assert.deepEqual(h.cleanup(), { stopped: 0, disposed: 0 });
  h.advance(1.7);
  assert.equal(h.cleanup().disposed, 1);
});

test('a new play interaction resumes a suspended context without replacing its running session', async () => {
  const h = harness();
  await h.transport.start();
  h.advance(0.1);
  h.context.state = 'suspended';
  assert.equal(await h.transport.start(), true);
  assert.equal(h.context.state, 'running');
  assert.equal(h.intervals.size, 1);
  assert.equal(h.scheduled.length, 1);
  assert.deepEqual(h.cleanup(), { stopped: 0, disposed: 0 });
});

test('stop also cancels release tails after a finite preview has naturally finished', async () => {
  let next = 0;
  const h = harness({ getNextEvent: () => next++ === 0 ? event('only') : null });
  await h.transport.start();
  h.advance(0.55);
  assert.equal(h.transport.getStatus().isRunning, false);
  h.transport.stop();
  assert.equal(h.cleanup().stopped, 1);
  h.advance(0.7);
  assert.equal(h.cleanup().disposed, 1);
  h.advance(2);
  assert.equal(h.cleanup().disposed, 1);
});

test('stop, restart, and clearing a saved clip do not leak timers or frozen mode', async () => {
  const h = harness();
  h.transport.setClip({ events: [event('saved')] });
  await h.transport.start();
  h.transport.stop();
  h.transport.setClip(null);
  assert.equal(await h.transport.start(), true);
  assert.equal(h.transport.getStatus().mode, 'live');
  assert.equal(h.intervals.size, 1);
  h.transport.stop();
  assert.equal(h.intervals.size, 0);
});

test('stop during asynchronous context resume prevents a late accidental start', async () => {
  let resume;
  const context = { currentTime: 0, state: 'suspended', resume: () => new Promise((resolve) => { resume = resolve; }) };
  const h = harness({ contextFactory: () => context });
  const starting = h.transport.start();
  h.transport.stop();
  context.state = 'running';
  resume();
  assert.equal(await starting, false);
  assert.equal(h.scheduled.length, 0);
  assert.equal(h.intervals.size, 0);
});

test('a rapid stop/start supersedes pending resume without its late rejection stopping the new session', async () => {
  const pending = [];
  const context = { currentTime: 0, state: 'suspended', resume: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) };
  const h = harness({ contextFactory: () => context });
  const first = h.transport.start();
  h.transport.stop();
  const second = h.transport.start();
  assert.equal(pending.length, 2);
  context.state = 'running';
  pending[1].resolve();
  assert.equal(await second, true);
  pending[0].reject(new Error('An older resume was cancelled'));
  assert.equal(await first, false);
  assert.equal(h.transport.getStatus().isRunning, true);
  assert.equal(h.callbacks.errors.length, 0);
  assert.equal(h.intervals.size, 1);
});

test('repeated ticks at exact fractional boundaries never complete or start an event twice', async () => {
  let next = 0;
  const h = harness({ getNextEvent: () => event(`e${++next}`, 1, 3) });
  await h.transport.start();
  for (let index = 1; index <= 12; index++) {
    const boundary = 0.025 + index / 6;
    h.advance(boundary);
    h.pulse(boundary);
    h.pulse(boundary);
  }
  assert.equal(h.callbacks.completed.length, 12);
  assert.equal(new Set(h.callbacks.completed.map((value) => value.stateId)).size, 12);
  assert.equal(h.callbacks.heard.length, 13);
  assert.equal(h.callbacks.errors.length, 0);
});

test('rest-only streams have normal history, freeze loops and unfreeze boundary semantics', async () => {
  let next = 0;
  const h = harness({ getNextEvent: () => event(`rest${++next}`, 1, 3, []) });
  await h.transport.start();
  h.advance(0.54);
  const clip = h.transport.freeze(2);
  assert.deepEqual(clip.events.map((value) => value.stateId), ['rest2', 'rest3']);
  assert.ok(clip.events.every((value) => value.sound.pitches.length === 0));
  h.advance(1.01);
  assert.equal(h.transport.getStatus().mode, 'frozen');
  h.transport.unfreeze();
  h.advance(1.21);
  assert.equal(h.transport.getStatus().mode, 'live');
  assert.equal(h.callbacks.resumed.length, 1);
  assert.equal(h.callbacks.errors.length, 0);
});

test('generator errors stop transport and report readable errors', async () => {
  const h = harness({ getNextEvent: () => event('bad', 0) });
  assert.equal(await h.transport.start(), false);
  assert.equal(h.transport.getStatus().mode, 'stopped');
  assert.match(h.callbacks.errors[0].message, /positive duration/);
  assert.equal(h.intervals.size, 0);
});
