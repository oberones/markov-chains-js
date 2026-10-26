# Development guide

## Scope and architecture

Markov Playground is a static Vite application written in plain JavaScript ES
modules. There is no backend, account, telemetry, cloud upload, runtime CDN, or
sample download. Keep README.md focused on the user's experience. Contributor
details and implementation contracts belong here.

- `src/core/`: exact rational timing, canonical sound objects, directed sparse
  chain training, seeded sampling, and four original example sequences.
- `src/import/`: browser MusicXML/MXL and MIDI inspection, part selection, and
  sequential pitch-set snapshots. Parsing a file must not replace the active toy
  until the user selects Explore.
- `src/audio/`: shared voice graph, live transport, offline WAV, MIDI encoding.
- `src/storage/`: strict portable version-1 toy validation and IndexedDB library.
- `src/app/`: DOM controls, accessible SVG constellation, and orchestration.

Runtime dependencies are pinned `midi-file` and `fflate`. Vite and Playwright are
development dependencies. Preserve the lockfile and runtime license notices.
The existing PDF is source material, not a generated asset; never overwrite it.
Soundbox supplied architectural inspiration only. Do not connect the app to its
legacy tracker, fixed-row scheduler, or separate live/PCM renderers.

## Data and mathematics contracts

`SoundObject` is `{pitches:number[],duration:{n,d},labels:string[]}`. Pitches are
unique sorted MIDI integers 0–127; `[]` is a rest. Durations are positive reduced
fractions of quarter-note beats. Labels retain spelling but do not change state
identity. `soundKey` is `JSON.stringify([pitches,n,d])`. Preserve exact arithmetic
until conversion for audio/MIDI scheduling; C4 is MIDI 60.

`MarkovModel` has stable insertion-ordered states, occurrence counts, observed
directed transition counts, separate synthetic boundary counts, and their combined
sparse transitions. Add last → one-beat rest → first exactly once. Do not count
the added rest or repeated first state as observed occurrences. The initial draw
is emitted before any transition. Uniform samples use `[0,1)` and strictly-greater
cumulative boundaries, skipping zero weights. State rows must remain nonempty.

Surprise maps each positive weight to `weight^(1/T)`, normalized over the whole
row, with `T` in `[0.5,2]` and default 1. Existing edges may be edited, including
to zero, but the last positive edge cannot be disabled. Graph viewport and search
filtering never change probabilities. The seed is stable and wraps PRNG arithmetic
to 32 bits for arbitrarily long live sessions.

## Import contracts

`inspectFile(file)` and `inspectBytes(name, bytes)` resolve to
`{name,parts:[{id,name}],readPart(id)}`. Selecting a part returns
`{events,tempo,warnings}`. Only selected note-bearing parts/channels are trained.
MusicXML is parsed with native DOMParser; do not fetch external entities or use
source strings as HTML. MIDI format 0/1 requires PPQN timing, and note boundaries
snap to 1/24 beat. MusicXML keeps exact timing and merges ties before slicing.

Boundaries from note starts/ends become chord/rest snapshots; repeated attacks
remain distinct even when pitches match. Generated snapshots retrigger all their
pitches, so disclose overlap simplification. Read the written score once and
report omitted expressive events. Unsupported pitch/timing formats fail clearly.

Limits: 5 MiB input, 10,000 selected note records, 4,096 normalized events, 512
states including the closing rest. MXL total expanded content is capped at 20 MiB,
each retained XML document at 10 MiB, and archive entries at 1,000; check streaming
output rather than trusting ZIP metadata. Never silently truncate or replace the
active source after an error. Ignore stale asynchronous reads/restorations.

## Audio and state contracts

`createTransport` consumes `{stateId,sound}` events. The AudioContext clock is the
authority; a short timer fills a bounded lookahead. UI callbacks fire when sounds
become audible or complete, not when scheduled. Freeze uses only completed events
and cancels scheduled-ahead work at a safe boundary. Unfreeze communicates the
boundary state to the generator before requesting its next event. A normal seeded
restart clears old history; resuming a stopped frozen phrase preserves its state.

Use the same `createSynth` graph for AudioContext and OfflineAudioContext. Live
changes apply to unscheduled sounds; volume ramps, stop fades, long held notes,
fractional beats, explicit rests, simultaneous chords, and cleanup must survive
changes. Background stalls re-anchor without a catch-up burst. Preserve all pitches
in a chord; bound release overlap by reclaiming old releasing voices. Stop also
silences the tail of a finished preview. Do not claim physical audio quality from
non-silent buffers or mocks.

`FrozenClip` is `{events:[{stateId,sound}]}`. The UI captures 8/16/32, or fewer
available events. Exports snapshot the clip, filename, and settings at click time.
WAV is stereo 44.1 kHz 16-bit PCM and includes the shared release/effect tail;
reject phrases over 180 seconds before the tail. MIDI uses 960 ticks/beat, off
before on at a shared boundary, positive minimum note length, and EndOfTrack after
the final note/rest. Tiny unrepresentable durations require explicit tick rounding.

`SavedToy` version 1 stores name/date, source sounds/warnings, seed, edited weights,
controls, and optional clip. Validate every read/write, source/edge/clip references,
limits, controls, and plain data. Restore paused. IndexedDB failure must leave
portable JSON save/open usable. Never store the original upload or running audio
resources in a saved toy.

## Validation

```sh
npm ci
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

`npm run check` runs tests, build, and the browser suite. Playwright automatically
starts Vite on loopback port 5173, or reuses a running local dev server. Tests use
Chromium. Independent concurrent browser runs must use different `--output`
directories to avoid collisions. Browser screenshots are written under
`artifacts/validation/`; test traces/results are ignored.

The checks cover mathematics, import fixtures including compressed archives,
storage validation/IndexedDB persistence, deterministic transport clocks, actual
Web Audio/offline synthesis, export contents, and complete user flows. Automated
browser audio checks verify signals and timing, not a human listening assessment.
Report Safari/Firefox, physical mobile-device performance, and listening as
unverified unless they were actually exercised. Do not present a production build
as published or deployed.

Use relative build paths so subdirectory static hosting works. Do not add cloud
services, hosting, ensemble arrangement, or performance recording
without a separate scope decision. Do not commit, push, or publish without an
explicit request.

## Container delivery and release

`Dockerfile` builds locked dependencies with Node 24.21.0 and copies only `dist/`
into Nginx 1.30.6. Both base images are digest pinned. Review upstream patches and
refresh the tags/digests together when maintaining the image. Runtime uses
UID/GID 101, port 8080, and writable temporary paths under `/tmp`. No Node runtime,
source uploads, secrets, or server-side persistence belong in the final image.
`.dockerignore` allowlists build inputs; keep runtime notices in `public/`.

The production reference is `deploy/compose.production.yml`: read-only root,
dropped capabilities, no new privileges, bounded tmpfs/resources/logs, an inherited
HTTP health check, loopback port 8091, and the external `web-backend` network.
Published images target `linux/amd64`, matching the sibling projects' current
workflows. ARM hosts require AMD64 emulation; native ARM publication is not enabled.

Run local container validation from the repository root:

```sh
docker buildx build --platform linux/amd64 --load -t markov-playground-js:verify .
bash scripts/container-smoke.sh markov-playground-js:verify
```

The smoke script creates and removes its own isolated network and Compose project,
using a temporary test override for the image, container name, and network. The
production Compose file keeps these values hardcoded. The smoke script
uses loopback port 18091 (override `MARKOV_PORT` if occupied), and checks health,
Nginx syntax, user identity, HTTP MIME/cache/security headers, notices, missing
assets, and disallowed methods. It never changes the production network.
It also runs the documented subdirectory proxy on an ephemeral loopback port,
checks the same HTTP contracts beneath the prefix, and verifies its 308 redirect.

### Manual production reference

After a successful tagged GHCR publication, prepare the deployment from the
repository root (requires Docker Engine with the Compose plugin):

```sh
# Inspect the existing proxy network; create it only if not already present.
docker network inspect web-backend
# docker network create web-backend
docker compose -f deploy/compose.production.yml config --quiet
docker compose -f deploy/compose.production.yml pull
docker compose -f deploy/compose.production.yml up -d --wait
```

The image is hardcoded to `ghcr.io/oberones/markov-playground-js:latest`, the
project/service/container name is `markov-playground-js`, and the external network
is hardcoded to `web-backend`. A successful stable release publishes `latest`.
Only the host port is configurable: optionally copy `deploy/.env.example` to
`deploy/.env`, edit `MARKOV_PORT`, and add `--env-file deploy/.env` to the commands.
For a private GHCR package, authenticate the deployment host with a token allowed
to read that package (`read:packages` for a classic PAT). Public packages can be
pulled anonymously. Store credentials with Docker, never in the Compose file.

Check `docker compose -f deploy/compose.production.yml ps`
and `logs` after updating. To roll back, edit the Compose `image` field to a
previous release tag or digest, then repeat `pull` and `up -d --wait`.
There are no server-side
data volumes to migrate; browser toys remain tied to their origin.

Terminate HTTPS at the existing front proxy. For a Docker proxy on `web-backend`,
the upstream is `http://markov-playground-js:8080/`, not the host-published port.
A proxy running directly on the host can use `http://127.0.0.1:8091/` instead.
`deploy/nginx-location.conf.example` shows the optional `/apps/markov-playground-js/`
mount and no-slash 308 redirect. The trailing slash in `proxy_pass` strips the
mount prefix; the app's relative build URLs then work at root or beneath that
prefix. Validate the proxy configuration before reloading and test the real URL.
If the container IP changes on recreation, reload a proxy that resolves its Docker
upstream only at startup. The container itself serves HTTP only; it does not
configure certificates or modify an existing proxy.

### GitHub Actions

`.github/workflows/publish.yml` runs on PRs, main pushes, and version-shaped tag
pushes. Independent jobs run `npm test`, the build and Chromium suite, and an
AMD64 image build plus the production Compose smoke check. PRs and main never
log in to GHCR or publish. Release publication needs both verification jobs.

Release tags are `X.Y.Z` (the `.cz.toml` default) or `vX.Y.Z`, optionally followed
by a SemVer prerelease such as `-rc.1`. The normalized version must equal
`package.json`; leading zeros and `+build` metadata are rejected. Stable releases
publish version, full `sha-<commit>`, and `latest` tags; prereleases omit `latest`.
`latest` follows successful publication order, including releases of older versions.
Avoid pushing both aliases for one release. The workflow serializes publication,
uses `GITHUB_TOKEN` with `packages: write` only in the publish job, and reports the
immutable digest in its summary. If the package already exists, it must grant
this repository's Actions access. Package visibility is configured in GitHub.

After explicitly approving a release, maintainers can push its version tag to
trigger publication. The workflow only publishes the image; deployment remains
manual. Local smoke checks do not establish hosted Actions/GHCR success, actual
HTTPS/proxy deployment, physical-device performance, or human audio quality.
