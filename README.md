# Markov Playground

A cosmic music toy for curious ears. Follow an evolving constellation of notes,
chords, and silences. Change a chance, hear a different possibility, and freeze a
moment you want to keep. No musical knowledge or account is needed.

## Take a little journey

1. Choose **Slow orbit**, **Lanterns**, **Cosmic hop**, or **Night drive** and press
   **Play**. Sound starts only after you interact with the app.
2. Change **Speed**, **Sound**, **Surprise**, or **Volume** while listening.
   Surprise favors familiar paths at its low end and makes the available paths
   more equally likely at its high end. **As learned** preserves their original
   proportions.
3. Select a light in the constellation, or find a sound in the searchable list.
   Its outgoing paths show what could happen next. Adjust a path's weight to
   change its chance. **Reset chances** restores the learned model and Surprise.
4. Press **Freeze** to repeat the last 8, 16, or 32 completed sounds. If you have
   heard fewer, it captures those. **Unfreeze** continues the walk from the last
   repeated sound. A sound already in progress finishes before the switch.
5. Download the frozen phrase as **WAV audio** or **MIDI notes**, or save the whole
   toy for another day.

**New journey** changes the seed. The seed inside **A repeatable little accident**
lets you revisit the same sequence with the same source and chance settings.
Stopping and playing an evolving journey starts it from its seed again. Unfreezing
a stopped moment continues from that moment when you press Play.

Use Tab to move between controls, Enter or Space to select a constellation node,
and the arrow keys to adjust sliders. Space outside a control toggles playback.
The app follows your system's reduced-motion setting. The sound selector and
searchable connection list provide an alternative to the constellation.

## Bring your own music

Choose a `.musicxml`, `.xml`, `.mxl`, or `.mid` file, select one part or MIDI
track/channel, and preview the training sounds. **Explore this part** replaces the
current universe. Files are read on your device and are never uploaded.

- MusicXML partwise scores retain exact note durations, dots/tuplets expressed in
  duration units, pitch alterations, transposition, ties, chords, and rests.
- MIDI format 0 and 1 files with beat-based timing are supported. Note boundaries
  are snapped to 1/24 beat so small performance differences do not create hundreds
  of almost-identical states.
- Overlapping notes become chord snapshots. A held note can sound again when
  another note changes. Preview lets you hear this interpretation before training.
- Playback uses one tempo. The import summary explains omitted expression,
  pedals, ornaments, grace notes, repeats, jumps, and later tempo changes.
  Percussion, microtonal pitches, MusicXML timewise scores, MIDI format 2, and
  SMPTE timing are not supported in this version.

Keep sources to short musical excerpts: 5 MiB per file, 10,000 selected note
records, 4,096 training sounds, and 512 distinct states including the closing
rest. MXL decompression is also bounded. Oversized sources are rejected with an
explanation instead of being silently cut short. Large constellations show a
neighborhood of up to 32 sounds (12 on narrow screens); the lists retain every
state and connection, and percentages always refer to the full model.

## Keep a moment

- **WAV** exports one frozen phrase using the current sound, speed, and volume,
  followed by its fading tail. Audio is stereo, 44.1 kHz, 16-bit PCM. A phrase may
  be up to three minutes before its tail; choose fewer captured sounds or a faster
  speed if it is longer. This is a clip export, not a recording of your live edits.
- **MIDI** exports the notes and rests at the current speed. Your music software's
  instrument determines how it sounds. Timing uses 960 ticks per beat.
- **Save here** adds a named toy to this browser's library. **Download toy** makes
  a portable JSON copy containing the training sounds, seed, chance edits, settings,
  and frozen phrase. **Open toy file** restores it paused, without the original
  source file. Browser storage can be cleared by browser settings; download toys
  you want to keep independently.

## Run locally

Use Node.js 22.12 or newer (developed and checked with Node.js 24).

```sh
npm ci
npm run dev
```

Open [localhost:5173](http://127.0.0.1:5173/). Stop the server with Ctrl+C.
Serve the app over HTTP; opening `index.html` directly from disk will not work.

To make a static build:

```sh
npm run build
npm run preview
```

The build is in `dist/`. Preview serves it at
[localhost:4173](http://127.0.0.1:4173/). Its relative asset paths also support a
static subdirectory with a trailing slash. No application server or database is
needed. Dependencies, fonts, sound generation, and file processing are local to
the built app; nothing is fetched from a CDN during play.

## The idea behind it

The playground learns how often each sound follows another sound. It then takes
a seeded random walk through those connections. A state is a pitch set plus its
duration, or a duration-bearing silence. The next choice depends only on the
current state: a first-order Markov chain.

The first sound is sampled from source occurrence frequencies. A quarter-note
rest connects the last training event back to the first, keeping the walk going.
Those extra paths do not change the observed starting frequencies. Surprise and
manual edits deliberately reshape the learned chances; freezing replays a path.

Based on Ilana Shapiro and Mark Huber's
[Markov Chains for Computer Music Generation](https://scholarship.claremont.edu/jhm/vol11/iss2/8/)
(2021). The original PDF remains in the project folder. Built-in motifs and the
shared Web Audio synthesizer were created for this playground. Runtime dependency
licenses are in [third-party notices](public/THIRD_PARTY_NOTICES.txt).

Contributor instructions and validation commands are in [AGENTS.md](AGENTS.md).
