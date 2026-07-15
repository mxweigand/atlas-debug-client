# atlas-debug-client

Browser-based debugging and monitoring tool for the **ATLAS** system — a voice-controlled AR assistant running on the HoloLens 2. The debug client makes the system's invisible data streams visible (audio, transcripts, tool calls, focus/deixis events) and can fully emulate a real HoloLens, so the entire voice pipeline can be developed and tested at a desk without the headset.

Angular 21 · standalone components · signals (zoneless, no zone.js) · RxJS

---

## Contents

- [The ATLAS system](#the-atlas-system)
- [Features](#features)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Server interfaces](#server-interfaces)
- [Protocol reference](#protocol-reference)
- [Key concepts](#key-concepts)
- [Development](#development)

---

## The ATLAS system

ATLAS consists of three repositories:

| Repository | Technology | Role |
|---|---|---|
| [atlas](https://github.com/mxweigand/atlas) | Unity / MRTK3 / UWP ARM64 | HoloLens 2 app: spatial annotation of industrial equipment (cuboid geometry, QR-code anchors), microphone streaming, assistant audio playback |
| [atlas-server](https://github.com/mxweigand/atlas-server) | NestJS / TypeScript | The hub: WebSocket gateway, broker to the OpenAI Realtime API, tool execution (incl. deixis resolution), project/object management (REST + JSON files) |
| [atlas-debug-client](https://github.com/mxweigand/atlas-debug-client) (this repo) | Angular 21 | Debug monitor + HoloLens emulator in the browser |

### Topology

```
                        ┌──────────────────────── atlas-server ───────────────────────┐
                        │                                                             │
HoloLens (atlas) ───────┤  WS :8080 /hololens ──┐                                     │
   OR                   │   (exclusive slot,    │                                     │
Debug Client            │    binary PCM16+JSON) ├── Broker ── OpenAI Realtime API     │
   (emulator)           │                       │      │                              │
                        │  WS :8080 /monitor ───┘      ├── ToolsService               │
Debug Client ───────────┤   (read-only,                │    (resolve_deixis,          │
   (monitor,            │    any number)               │     get_object,              │
    always connected)   │                              │     update_object, …)        │
                        │  HTTP :3000 /projects        │                              │
Debug Client ───────────┤   (REST: projects/objects)── ProjectsService ── data/*.json │
                        └─────────────────────────────────────────────────────────────┘
```

The debug client uses **all three** interfaces at the same time:

1. **`/monitor`** (WebSocket, connected automatically on startup) — receives all of the server's debug streams, never sends anything. Any number of monitor clients can be connected in parallel, including while a real HoloLens is connected.
2. **`/hololens`** (WebSocket, connected manually via button) — the exclusive single-client slot normally held by the real HoloLens. When the debug client takes it, it acts as a full emulator: microphone in, assistant audio out, focus stream in.
3. **REST `:3000`** — fetch the project list, activate/deactivate projects, reload object details.

---

## Features

### Three-column UI

```
┌────────────┬──────────────────────────────┬─────────────────┐
│ HoloLens   │  Event Log                   │  Projects /     │
│ emulator   │  (all /monitor events,       │  Project        │
│ + audio    │   audio player, transcript   │  (object list,  │
│            │   deltas, tool payloads)     │   live focus)   │
└────────────┴──────────────────────────────┴─────────────────┘
```

Header bar: `/monitor` connection state (incl. monitor count), `/hololens` slot occupancy (`connected` / `connected (emulator)` / `disconnected`), and the active project.

### HoloLens emulator (left column)

- **Take/release the slot**: connects to `/hololens` and declares itself as role `debug` via a `hello` frame. If the slot is occupied (real HoloLens), the server rejects with close code 1008 → state `rejected`.
- **Microphone streaming**: browser microphone → 24 kHz mono PCM16 → binary WebSocket frames to the server (the exact format the real HoloLens sends). The mic button takes the slot automatically if needed. While a real HoloLens is connected, the microphone is disabled.
- **Assistant audio**: incoming binary frames (TTS responses) are played gaplessly through the Web Audio API (continuous play queue via `nextPlayTime`).
- **Focus emulation**: hovering over an object entry in the project panel sends `focus_update` messages — immediately on change plus a 4 Hz heartbeat (250 ms), exactly matching the pointing behavior of the real HoloLens. This makes deixis resolution ("take **that** one") testable without the headset.

### Event log (center)

- Structured, scrolling log of all `/monitor` events (max. 200 entries, oldest evicted).
- **`user_speech`**: playable audio clip of the user's utterance with duration. During playback a cursor runs across the transcript deltas (word highlighting in sync with the audio, see [latency alignment](#latency-alignment-of-transcript-deltas)).
- **Transcript deltas**: every word fragment with its `+…ms` offset relative to the start of the audio — transcription latency is directly readable.
- **Deixis markers**: results of the `resolve_deixis` tool are pinned as a badge to the corresponding delta word (resolved object id or `unresolved`).
- **`assistant_speech`**: playable assistant response including its transcript.
- **`tool_call` / `tool_result`**: name plus collapsible pretty-printed JSON payload.
- Lifecycle events (`speech_started`, `speech_ended`, `response_started`, `response_done`), errors, topology changes (`mode_changed`), and object CRUD broadcasts.
- `focus_update` broadcasts are deliberately **not** logged (a 4 Hz heartbeat would drown out everything else) — the live focus is shown in the project panel instead.

### Project panel (right column)

- Project list from the server (REST); activate/deactivate a project with one click.
- Object list of the active project with expandable JSON (name, summary, content, geometry).
- **Live focus indicator**: the server rebroadcasts the `/hololens` client's focus stream to `/monitor`; the currently targeted object gets a `⬤ FOCUS` badge — works with the real HoloLens as well as the emulator.
- Object broadcasts (`object_created` / `object_updated` / `object_deleted`) are patched into the view live; `project_activated` reloads the details.

---

## Quick start

### Prerequisites

- Node.js (npm ≥ 10); the Angular CLI is provided locally via devDependencies
- A running [**atlas-server**](https://github.com/mxweigand/atlas-server) (default: WS on `:8080`, REST on `:3000`)
- A Chromium-based browser (Web Audio + `getUserMedia`)

### Run

```bash
npm install
npm start          # = ng serve → http://localhost:4200
```

On load, the app automatically connects to `ws://localhost:8080/monitor` and fetches the project list from `http://localhost:3000`. The `/hololens` slot is **not** taken automatically — that only happens via the "Take /hololens" button or implicitly when starting the microphone.

### Typical debug workflow without a HoloLens

1. Start atlas-server, open the debug client.
2. Activate a project in the right panel — this is what brings up the OpenAI Realtime session; an idle server has no session.
3. Click "Start Mic" (takes the `/hololens` slot automatically) and talk to the assistant.
4. For deixis tests: while speaking, hover the mouse over an object in the project panel ("take this one") — the hover stands in for the headset's pointing ray.
5. In the log: replay the turn, inspect word timing, tool calls, and deixis resolution.

### Alongside a real HoloLens

Just use the monitor (the default state): all streams are visible without touching the `/hololens` slot. The UI shows `hololens: connected` and locks the microphone/emulator while the headset is connected.

---

## Configuration

The server addresses are currently **hardcoded** in [`src/app/app.ts`](src/app/app.ts):

```ts
private readonly serverHost = 'ws://localhost:8080';   // WS gateway
private readonly restBase   = 'http://localhost:3000'; // REST
```

To test against a server on the LAN (e.g. when a real HoloLens participates), adjust these two constants. A config file / discovery step is planned but not implemented yet.

The server-side counterparts are the environment variables `WS_PORT` (default 8080) and `PORT` (default 3000).

---

## Architecture

### Project structure

```
src/
├── main.ts                     Bootstrap (zoneless, standalone)
├── app/
│   ├── app.ts / app.html / app.scss   Root component: wires up all services,
│   │                                  renders the three panels
│   ├── app.config.ts           Providers (HttpClient, global error listeners)
│   ├── protocol/
│   │   ├── messages.ts         Wire protocol (copy of the server master!)
│   │   ├── audio.ts            Audio format constants (copy of the server master!)
│   │   └── index.ts
│   └── services/
│       ├── hololens.service.ts   WS /hololens (emulator channel)
│       ├── monitor.service.ts    WS /monitor (read-only debug stream)
│       ├── audio.service.ts      Mic capture + live playback (Web Audio)
│       ├── playback.service.ts   Clip playback from the log + delta cursor
│       ├── log.service.ts        Event aggregation into the structured log
│       ├── focus.service.ts      Focus emulation (change + 250 ms heartbeat)
│       └── projects.service.ts   REST client + live mirror of project state
```

### Services at a glance

| Service | Responsibility | Key API |
|---|---|---|
| `HololensService` | WS connection to `/hololens`; sends `hello` (role `debug`), microphone PCM, and `focus_update`; receives assistant audio + events. Detects slot rejection (1008 → `rejected`). | `state$`, `events$`, `incomingAudio$`, `connect()`, `sendAudio()`, `sendMessage()` |
| `MonitorService` | WS connection to `/monitor`; receive-only. Keeps the latest `mode_changed` in a `BehaviorSubject` for the topology display. | `state$`, `events$`, `mode$` |
| `AudioService` | Microphone → `ScriptProcessorNode` (512 samples ≈ 21 ms) → Float32→PCM16 → `pcmChunk$`. Incoming PCM16 → Float32 → gapless playback. | `startMic()`, `stopMic()`, `playPcm16()`, `micActive$`, `pcmChunk$` |
| `LogService` | Turns the `/monitor` stream into a structured log; stitches transcripts, deltas, and deixis markers onto their `user_speech` row regardless of arrival order (see below). Max. 200 entries. | `entries` (signal), `append()`, `clear()` |
| `PlaybackService` | Plays `user_speech`/`assistant_speech` clips (PCM16 → WAV container → `HTMLAudioElement`), skips the lookback prefix (`playbackTrimMs`), and exposes the active delta index for word highlighting. | `play()`, `stop()`, `playingEntryId`, `activeDeltaIndex()` |
| `FocusService` | Holds the currently "pointed-at" object; sends `focus_update` immediately on change plus every 250 ms as a heartbeat over the `/hololens` socket. | `setFocus()`, `current` |
| `ProjectsService` | REST calls (`/projects`…) plus in-place patching of the object list on monitor broadcasts. Signals instead of manual subscriptions. | `projects`, `active`, `refreshList()`, `activate()`, `deactivate()`, `applyObject*()` |

### Data flow

```
                    ┌────────────────────── App (root component) ────────────────────────┐
                    │                                                                    │
/monitor  ──events$─┼─► LogService ──entries──► event log panel                          │
                    │      ▲                                                             │
                    │      └── PlaybackService (clip player + delta cursor)              │
                    │                                                                    │
/monitor  ──events$─┼─► ProjectsService (project_activated / object_* / focus_update)    │
                    │        ▲    └──projects/active──► project panel                    │
        REST :3000 ─┼────────┘                                                           │
                    │                                                                    │
/hololens ─audio───►┼─► AudioService.playPcm16()      (assistant voice, live)            │
/hololens ◄──pcm────┼── AudioService.pcmChunk$        (browser microphone)               │
/hololens ◄──json───┼── FocusService                  (hover in the project panel)       │
                    └────────────────────────────────────────────────────────────────────┘
```

The root component is the only place where services are wired together (in `ngOnInit`); the services themselves — except for `FocusService → HololensService` — don't know about each other.

---

## Server interfaces

### WS `/hololens` — emulator channel (exclusive)

| Property | Value |
|---|---|
| Capacity | exactly **1** client ("first wins"); a second connection is rejected with close code 1008 |
| Binary in | assistant TTS as PCM16 frames |
| Binary out | microphone PCM16 frames |
| JSON out | `hello` (once, role `debug`), `focus_update` (change + 4 Hz heartbeat) |
| JSON in | lifecycle events (`speech_*`, `response_*`), `tool_call`/`tool_result`, `error`, project broadcasts |

### WS `/monitor` — debug stream (read-only)

Any number of clients. Right after connect, the server sends a `mode_changed` snapshot (current topology) and, if applicable, the current project state; after that, all debug broadcasts. The client never sends anything.

### REST `http://localhost:3000`

| Method & path | Purpose | Used by the debug client |
|---|---|---|
| `GET /projects` | project list | ✅ (right panel) |
| `GET /projects/:id` | project + objects | ✅ (reload after `project_activated`) |
| `POST /projects/:id/activate` | activate a project (`mode: view\|edit`, default `view`) | ✅ (always `view`) |
| `POST /projects/deactivate` | deactivate the project | ✅ |
| `POST /projects/:id/objects` | create an object | ❌ (HoloLens only) |
| `PATCH /projects/:id/objects/:objectId` | update an object | ❌ |
| `DELETE /projects/:id/objects/:objectId` | delete an object | ❌ |

Mutations go through the HoloLens or the assistant's `update_object` tool; the debug client receives the results as `object_*` broadcasts and patches its view live.

### Audio format

Binding for **all** participants (defined in [`src/app/protocol/audio.ts`](src/app/protocol/audio.ts)):

| Parameter | Value |
|---|---|
| Sample rate | 24,000 Hz |
| Channels | 1 (mono) |
| Bit depth | 16 bit (little-endian, signed) |
| Chunk duration | 20 ms (= 960 bytes) — nominal; the browser capture uses 512-sample blocks (~21 ms) |

Mismatches show up as distorted / too-fast / too-slow audio.

---

## Protocol reference

Complete, commented definitions live in [`src/app/protocol/messages.ts`](src/app/protocol/messages.ts). The file is a **verbatim copy** of [`src/protocol/messages.ts` in atlas-server](https://github.com/mxweigand/atlas-server/blob/main/src/protocol/messages.ts) — the server is the master; changes must be kept in sync manually (as of today, both files are identical).

### Server → client

| Type | Channel | Meaning |
|---|---|---|
| `speech_started` / `speech_ended` | both | OpenAI VAD: user started / stopped speaking |
| `response_started` / `response_done` | both | assistant begins / finishes a response |
| `tool_call` / `tool_result` | both | assistant tool invocation incl. args/result |
| `error` | both | server-side error message |
| `mode_changed` | /monitor | topology: who holds `/hololens` (`hololens` / `debug` / `null`), number of monitors |
| `user_transcript` | /monitor | final user transcript of a turn (referenced by `itemId`) |
| `user_transcript_delta` | /monitor | streaming word fragment with timing (`audioOffsetMs`, `spokenOffsetMs`) |
| `user_speech` | /monitor | complete PCM16 clip of the user turn (base64) incl. lookback prefix, `playbackTrimMs` |
| `assistant_transcript` | /monitor | final assistant transcript |
| `assistant_speech` | /monitor | complete PCM16 clip of the assistant response (base64) |
| `focus_update` | /monitor | rebroadcast of the focus stream from the `/hololens` client |
| `project_activated` | both | active project changed (`projectId` or `null`) |
| `object_created` / `object_updated` / `object_deleted` | both | object CRUD broadcast |

### Client → server (only on `/hololens`)

| Type | Meaning |
|---|---|
| `hello` | role declaration (`hololens` / `debug`); without `hello` the server assumes `debug` |
| `focus_update` | what the user is currently pointing at (`focusId` or `null`) + client wallclock |

### Data model

An `AtlasProject` (id, name, summary) contains `AtlasObject`s (id, name, summary, content, geometry). An object's `id` doubles as the `focusId` in the pointing stream and is what the deixis resolver returns. `geometry` (cuboid size, rotation, QR anchors) is authored exclusively by the HoloLens; the server and the debug client treat it as opaque data.

---

## Key concepts

### The `/hololens` slot and the three operating states

The server has exactly one input channel. This gives the debug client three states, shown in the header bar:

1. **Slot free** — pure monitor view; the emulator can take over.
2. **Slot held by the debug client** ("connected (emulator)") — full emulator operation: microphone, focus hover, assistant audio in the browser.
3. **Slot held by a real HoloLens** ("connected") — microphone and emulator are locked; the debug client remains a pure observer but still sees everything, including the headset's live focus.

### Deixis debugging (the tool's core purpose)

"Deixis" = verbal pointing reference ("take **that**", "what's in **here**?"). Resolution works via time alignment: the server buffers the focus stream (what the user points at, and when) and the transcript deltas (when each word was spoken) on **one shared clock** (server receive time — client wallclocks may drift, especially on a real HoloLens). When the assistant calls the `resolve_deixis` tool, the server locates the deictic word in the transcript buffer and reads back the focus that was active at the estimated speak time.

The debug client makes exactly this chain verifiable:

- Focus emulation via hover stands in for the headset's pointing ray.
- Every transcript delta shows its offset; deixis results appear as a badge directly on the resolved word.
- During playback, the clip player shows which word is currently being "heard" — misalignments become visible immediately.

### Latency alignment of transcript deltas

A `user_speech` clip does not start at `speech_started` but `AUDIO_LOOKBACK_MS` (server default 1500 ms) earlier: the server prepends its rolling microphone buffer so the word onset cut off by VAD survives. This produces the timing fields:

- `audioOffsetMs` — server receive time of the delta relative to the clip start (t=0 = oldest lookback sample). This is the *visible transcription latency*.
- `spokenOffsetMs` — the same minus `DEIXIS_PIPELINE_LATENCY_MS` (server default 1000 ms): the estimated actual speak time. The `PlaybackService` compares the playback position against this value for word highlighting.
- `playbackTrimMs` — how much of the lookback prefix the player skips on playback so it starts close to the real speech onset.

### Order-independent log stitching

A turn's transcript, deltas, audio blob, and deixis markers arrive in no guaranteed order. The `LogService` joins them via the OpenAI `itemId`: anything that arrives before its `user_speech` row lands in pending buffers and is stitched on once the row appears. Likewise, a late `assistant_transcript` is attached to the most recent `assistant_speech` row. The result: one row per turn, no matter the order in which the server delivers.

---

## Development

### Scripts

```bash
npm start        # dev server (ng serve, port 4200)
npm run build    # production build into dist/
npm run watch    # dev build in watch mode
npm test         # ng test (no spec files exist yet)
```

### Conventions & notes

- **Protocol sync**: `src/app/protocol/{messages,audio}.ts` are copies of the server master ([`src/protocol/` in atlas-server](https://github.com/mxweigand/atlas-server/tree/main/src/protocol)). For protocol changes, change the server first, then update the copies here — ideally verify with a file diff.
- **State management**: signals for UI state, RxJS subjects for event streams from the WebSockets; `toSignal()` at the seam. No zone.js — change detection runs zoneless.
- **Formatting**: Prettier (`.prettierrc`: 100 chars, single quotes).
- **Known stopgaps**:
  - Server URLs hardcoded in `app.ts` (see [Configuration](#configuration)).
  - No auth — the server currently accepts every connection (auth stub; Microsoft Identity is on the roadmap).
  - `ScriptProcessorNode` is deprecated (successor: `AudioWorklet`) but works in all target browsers.
  - After auto-taking the slot, mic start waits a flat 300 ms for the connection to establish.

---

## AI Usage Declaration

This project was developed with the assistance of [Claude Code](https://claude.com/claude-code) (Anthropic), using the Claude Opus 4.8 model.
