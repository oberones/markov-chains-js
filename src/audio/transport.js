import { AUDIO_TAIL_SECONDS, createSynth, normalizeAudioSettings, soundDuration } from './synth.js';

const LOOKAHEAD = 0.12;
const SAFETY = 0.025;
const EPSILON = 1e-7;
const MAX_HISTORY = 4096;
const copy = (value) => value == null ? value : structuredClone(value);

/** Event time is driven by the audio clock; the timer only fills a short queue. */
export function createTransport(options = {}) {
  const contextFactory = options.contextFactory ?? (() => {
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Context) throw new Error('This browser does not support Web Audio.');
    return new Context();
  });
  const synthFactory = options.synthFactory ?? createSynth;
  const interval = options.setIntervalFn ?? globalThis.setInterval.bind(globalThis);
  const clearInterval = options.clearIntervalFn ?? globalThis.clearInterval.bind(globalThis);
  const timeout = options.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
  let settings = normalizeAudioSettings(options);
  let context = null;
  let synth = null;
  let timer = null;
  let running = false;
  let starting = null;
  let runToken = 0;
  let mode = 'stopped';
  let playbackKind = 'live';
  let clip = null;
  let clipIndex = 0;
  let nextTime = 0;
  let records = [];
  let completed = [];
  let exhausted = false;
  let transition = null;
  let lastHeardState = null;
  const retiringSynths = new Set();

  function notify(name, ...args) {
    try { options[name]?.(...args); }
    catch (error) {
      if (name !== 'onError') {
        try { options.onError?.(error); } catch { /* UI callbacks cannot break audio cleanup. */ }
      }
    }
  }

  function setMode(value) {
    if (mode === value) return;
    mode = value;
    notify('onMode', value);
  }

  function stopTimer() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  function releaseSynth(fade = true) {
    if (!synth) return;
    const old = synth;
    synth = null;
    if (fade) old.stop(context.currentTime);
    retiringSynths.add(old);
    timeout(() => {
      if (retiringSynths.delete(old)) old.dispose();
    }, fade ? 65 : Math.ceil(AUDIO_TAIL_SECONDS * 1000));
  }

  function stop() {
    runToken += 1;
    starting = null;
    running = false;
    stopTimer();
    for (const old of retiringSynths) {
      old.stop(context.currentTime);
      timeout(() => { if (retiringSynths.delete(old)) old.dispose(); }, 65);
    }
    releaseSynth();
    records = [];
    transition = null;
    exhausted = false;
    nextTime = 0;
    setMode('stopped');
  }

  function fail(error) {
    stop();
    notify('onError', error instanceof Error ? error : new Error(String(error)));
  }

  function synchronize(now) {
    if (transition && now + EPSILON >= transition.at) {
      setMode(transition.kind === 'live' ? 'live' : 'frozen');
      transition = null;
    }
    for (const record of records) {
      const metadata = { startTime: record.when, endTime: record.end, mode: record.kind };
      if (!record.started && now + EPSILON >= record.when) {
        record.started = true;
        lastHeardState = record.event.stateId;
        notify('onEvent', copy(record.event), metadata);
      }
      if (!record.completed && now + EPSILON >= record.end) {
        record.completed = true;
        completed.push(copy(record.event));
        if (completed.length > MAX_HISTORY) completed.splice(0, completed.length - MAX_HISTORY);
        notify('onComplete', copy(record.event), metadata);
      }
    }
    records = records.filter((record) => !record.completed);
  }

  function tick() {
    if (!running || context.state === 'suspended' || context.state === 'interrupted') return;
    if (context.state === 'closed') return fail(new Error('The audio device was closed. Start again to reconnect.'));
    try {
      const now = context.currentTime;
      synchronize(now);
      if (exhausted && records.length === 0) {
        running = false;
        stopTimer();
        releaseSynth(false);
        setMode('stopped');
        return;
      }
      // Throttled/background timers never cause a burst of stale notes.
      if (nextTime < now) nextTime = now + SAFETY;
      const horizon = now + LOOKAHEAD;
      let scheduled = 0;
      while (!exhausted && nextTime < horizon && scheduled < 128) {
        const event = playbackKind === 'frozen'
          ? clip?.events[clipIndex++ % clip.events.length]
          : options.getNextEvent?.();
        if (!event) {
          exhausted = true;
          break;
        }
        if (typeof event.stateId !== 'string') throw new TypeError('The generator returned an invalid event.');
        const duration = soundDuration(event.sound, settings.tempo);
        const handle = synth.scheduleSound(event.sound, nextTime, settings);
        records.push({ event: copy(event), when: nextTime, end: nextTime + duration, kind: playbackKind, started: false, completed: false, handle });
        nextTime += duration;
        scheduled += 1;
      }
      if (scheduled === 128 && nextTime < horizon) {
        throw new RangeError('The source has too many very short events to play safely.');
      }
    } catch (error) { fail(error); }
  }

  function start() {
    if (running) {
      if (context.state === 'suspended' || context.state === 'interrupted') {
        const token = runToken;
        return context.resume().then(() => {
          if (token !== runToken) return false;
          tick();
          return running;
        }, (error) => { if (token === runToken) fail(error); return false; });
      }
      return Promise.resolve(true);
    }
    if (starting) return starting;
    const token = ++runToken;
    const request = (async () => {
      try {
        if (!context || context.state === 'closed') context = contextFactory();
        if (context.state === 'suspended' || context.state === 'interrupted') await context.resume();
        else await Promise.resolve();
        if (token !== runToken) return false;
        synth = synthFactory(context, settings);
        running = true;
        exhausted = false;
        records = [];
        transition = null;
        clipIndex = 0;
        playbackKind = clip?.events.length ? 'frozen' : 'live';
        nextTime = context.currentTime + SAFETY;
        setMode(playbackKind === 'frozen' ? 'frozen' : 'live');
        timer = interval(tick, 25);
        tick();
        return running;
      } catch (error) {
        if (token === runToken) fail(error);
        return false;
      }
    })();
    starting = request;
    request.finally(() => { if (starting === request) starting = null; });
    return request;
  }

  function update(next) {
    settings = normalizeAudioSettings(next, settings);
    synth?.update(settings);
  }

  function switchAtBoundary(kind) {
    const now = context.currentTime;
    synchronize(now);
    const current = records.find((record) => record.when <= now + EPSILON && record.end > now + EPSILON);
    const boundary = current ? current.end : now + SAFETY;
    const retained = [];
    for (const record of records) {
      if (record.when >= boundary - EPSILON) record.handle.cancel(boundary, 0);
      else retained.push(record);
    }
    records = retained;
    nextTime = boundary;
    exhausted = false;
    playbackKind = kind;
    clipIndex = 0;
    transition = { at: boundary, kind };
    setMode(kind === 'frozen' ? 'freezing' : 'unfreezing');
    if (kind === 'live') notify('onResumeFromState', current?.event.stateId ?? lastHeardState);
    tick();
  }

  function freeze(count = 16) {
    if (running) synchronize(context.currentTime);
    const size = Math.max(1, Math.min(MAX_HISTORY, Math.floor(Number(count) || 16)));
    if (!completed.length) return null;
    clip = { events: copy(completed.slice(-size)) };
    if (running) switchAtBoundary('frozen');
    else playbackKind = 'frozen';
    return copy(clip);
  }

  function unfreeze() {
    if (!clip) return lastHeardState;
    if (running) switchAtBoundary('live');
    else {
      playbackKind = 'live';
      notify('onResumeFromState', lastHeardState ?? clip.events.at(-1)?.stateId ?? null);
    }
    clip = null;
    return lastHeardState;
  }

  function setClip(value) {
    if (running) stop();
    if (value != null) {
      if (!Array.isArray(value.events) || value.events.length === 0) throw new TypeError('A frozen phrase needs at least one event.');
      value.events.forEach((event) => {
        if (typeof event.stateId !== 'string') throw new TypeError('The phrase contains an invalid event.');
        soundDuration(event.sound, settings.tempo);
      });
    }
    clip = copy(value);
    playbackKind = clip ? 'frozen' : 'live';
    clipIndex = 0;
    completed = [];
    lastHeardState = null;
  }

  return {
    start, stop, update, freeze, unfreeze, setClip,
    getClip: () => copy(clip),
    getStatus: () => ({ mode, isRunning: running, completedCount: completed.length, clipLength: clip?.events.length ?? 0, ...settings }),
    getAudioTime: () => context?.currentTime ?? 0,
    getAnalyser: () => synth?.analyser ?? null,
  };
}
