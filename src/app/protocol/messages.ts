// Wire protocol between atlas-server and its clients (HoloLens + debug client).
// This file is the master. Clients have to follow it exactly. Possibly by keeping a copy of it if they implement it directly in TypeScript.

// ─── Project / object shapes (shared data model) ──────────────────────────────

/**
 * A 3D vector, serialized exactly as Unity's JsonUtility emits it (`{ x, y, z }`).
 * Positions and sizes are in meters, Euler angles in degrees.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Anchors an object to a physical QR code. `markerId` is the code's decoded
 * string, `size` its printed edge length (m). `localPosition` /
 * `localEulerAngles` locate the marker in the object's local (scaled) space, so
 * the object's world pose can be reconstructed from the scanned marker pose.
 */
export interface QRAnchor {
  markerId: string;
  size: number;
  localPosition: Vec3;
  localEulerAngles: Vec3;
}

/**
 * Geometry of an atlas object. Authored and owned exclusively by the HoloLens
 * (created/updated via REST); the server stores it verbatim and never mutates
 * it. `size` is the cuboid's extent (m), `eulerAngles` its world rotation at
 * authoring time (deg), `anchors` the QR codes used to re-place it in the world.
 */
export interface AtlasGeometry {
  size: Vec3;
  eulerAngles: Vec3;
  anchors: QRAnchor[];
}

/**
 * A single addressable object inside a project. `id` doubles as the focusId
 * emitted on /hololens — the same value the deixis resolver returns. `summary` is
 * short, injected verbatim into the system prompt at session start. `content`
 * is the full description, retrieved on demand via the describe_object tool.
 * `geometry` follows {@link AtlasGeometry}; `null` until the HoloLens has
 * authored a shape for the object.
 *
 * The parent project is not stored on the object — it's implicit from where
 * the object lives (either its JSON file or the active project).
 */
export interface AtlasObject {
  id: string;
  name: string;
  summary: string;
  content: string;
  geometry: AtlasGeometry | null;
}

/**
 * A named collection of objects. `summary` is an optional project-level intro
 * also injected into the system prompt at session start.
 *
 * `id` is NOT stored in the project file — it is derived from the filename
 * (`<id>.json`) when read, so filename and id can never diverge. It is present
 * on the in-memory/API shape but omitted on disk.
 */
export interface AtlasProject {
  id: string;
  name: string;
  summary?: string;
}

// ─── Server -> Client (broadcast on /hololens and /monitor as appropriate) ───

/** Emitted when OpenAI VAD detects the user has started speaking. */
export interface SpeechStartedMessage {
  type: 'speech_started';
}

/** Emitted when OpenAI VAD detects the user has stopped speaking. */
export interface SpeechEndedMessage {
  type: 'speech_ended';
}

/** Emitted when the assistant begins generating a response. */
export interface ResponseStartedMessage {
  type: 'response_started';
}

/** Emitted when the assistant response is fully done. */
export interface ResponseDoneMessage {
  type: 'response_done';
}

export interface ToolCallMessage {
  type: 'tool_call';
  callId: string;
  name: string;
  args: unknown;
}

export interface ToolResultMessage {
  type: 'tool_result';
  callId: string;
  name: string;
  result: unknown;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

// ─── /monitor-only Server -> Debug-Client streams ─────────────────────────────

/** Final user transcript for the referenced turn. Monitor-only. */
export interface UserTranscriptMessage {
  type: 'user_transcript';
  itemId: string;
  transcript: string;
}

/** Final assistant transcript for the last response. Monitor-only. */
export interface AssistantTranscriptMessage {
  type: 'assistant_transcript';
  transcript: string;
}

/**
 * Complete PCM16 audio (base64) of the user turn. The blob actually starts
 * `AUDIO_LOOKBACK_MS` before speech_started because the server prepends its
 * rolling mic buffer so the VAD-cut prefix survives.
 *
 * - `audioStartWallclockMs`: wallclock at t=0 of the blob (i.e. the oldest
 *   lookback sample). Same anchor `audioOffsetMs`/`spokenOffsetMs` measure
 *   against.
 * - `playbackTrimMs`: how many ms of the leading lookback the client should
 *   skip when playing the clip in a UI player. Equals
 *   `DEIXIS_PIPELINE_LATENCY_MS`, leaving `lookbackMs - pipelineLatencyMs` of
 *   safety padding for the VAD onset delay. The delta timeline is unchanged;
 *   `spokenOffsetMs` on each delta still measures from t=0 of the blob.
 *
 * Monitor-only.
 */
export interface UserSpeechMessage {
  type: 'user_speech';
  itemId: string;
  audio: string;
  audioStartWallclockMs: number;
  playbackTrimMs: number;
}

/**
 * Complete PCM16 audio (base64) of the assistant response from
 * response_started to response_done. Monitor-only.
 */
export interface AssistantSpeechMessage {
  type: 'assistant_speech';
  audio: string;
}

/**
 * Streaming word/token fragment from the OpenAI transcription. One event per
 * delta. Monitor-only — used for latency alignment against the user_speech
 * player. `audioOffsetMs` is the delta's server-receive time relative to
 * `audioStartWallclockMs` of the same turn. `spokenOffsetMs` is the same
 * value minus `DEIXIS_PIPELINE_LATENCY_MS`; it estimates when the word was
 * actually spoken and is what the client should compare against the playback
 * position to place the highlight on the currently-heard word.
 */
export interface UserTranscriptDeltaMessage {
  type: 'user_transcript_delta';
  itemId: string;
  delta: string;
  wallclockMs: number;
  audioOffsetMs: number;
  spokenOffsetMs: number;
}

/**
 * Current connection topology. Broadcast to /monitor whenever the /hololens
 * slot or the /monitor client set changes. `hololensClient` is 'hololens'
 * when the slot is occupied by a real HoloLens (path /hololens with role
 * hint), 'debug' when it's the debug client emulating, and null when free.
 */
export interface ModeChangedMessage {
  type: 'mode_changed';
  hololensClient: 'hololens' | 'debug' | null;
  monitorClients: number;
}

/**
 * Rebroadcast of a focus_update the server received on /hololens. Sent to
 * /monitor clients so a debug view can render the pointing stream live.
 * Payload is identical to the client-side FocusUpdateMessage.
 */
export interface FocusUpdateBroadcastMessage {
  type: 'focus_update';
  wallclockMs: number;
  focusId: string | null;
}

/**
 * Broadcast whenever the active project changes (activation, deactivation).
 * Sent to /monitor and /hololens so both stay in sync with the server state.
 * `projectId` is null while the server is idle (no project loaded).
 */
export interface ProjectActivatedMessage {
  type: 'project_activated';
  projectId: string | null;
}

/**
 * Broadcast whenever an object's mutable fields (name, summary, content) have
 * been patched — either through the update_object tool or a REST PATCH. The
 * parent project is carried alongside since the object itself no longer
 * stores it.
 */
export interface ObjectUpdatedMessage {
  type: 'object_updated';
  projectId: string;
  object: AtlasObject;
}

/** Broadcast when a new object is created via REST POST. */
export interface ObjectCreatedMessage {
  type: 'object_created';
  projectId: string;
  object: AtlasObject;
}

/** Broadcast when an object is deleted via REST DELETE. */
export interface ObjectDeletedMessage {
  type: 'object_deleted';
  projectId: string;
  objectId: string;
}

export type ServerMessage =
  | SpeechStartedMessage
  | SpeechEndedMessage
  | ResponseStartedMessage
  | ResponseDoneMessage
  | ToolCallMessage
  | ToolResultMessage
  | ErrorMessage
  | ModeChangedMessage
  | UserTranscriptMessage
  | AssistantTranscriptMessage
  | UserSpeechMessage
  | UserTranscriptDeltaMessage
  | AssistantSpeechMessage
  | FocusUpdateBroadcastMessage
  | ProjectActivatedMessage
  | ObjectUpdatedMessage
  | ObjectCreatedMessage
  | ObjectDeletedMessage;

// ─── Client -> Server ─────────────────────────────────────────────────────────

/**
 * Sent once by clients connecting to /hololens to declare their identity.
 * If omitted, the server assumes 'debug'. Purely informational — the server
 * treats both roles identically.
 */
export interface HelloMessage {
  type: 'hello';
  role: 'hololens' | 'debug';
}

/**
 * Continuous pointing/focus stream from the /hololens client. Emitted on change
 * plus a low-rate heartbeat so the server always knows whether the pointer is
 * still on the same target. `focusId` is null when the user is not pointing
 * at any known object. `wallclockMs` is the client's Date.now() at capture,
 * kept for reference/debugging only: for deixis alignment the server stamps
 * each focus sample with its own receive time, because the client clock may be
 * skewed against the server clock (e.g. a real HoloLens on a separate device).
 * That keeps focus and transcript-delta timestamps on one common clock.
 */
export interface FocusUpdateMessage {
  type: 'focus_update';
  wallclockMs: number;
  focusId: string | null;
}

export type ClientMessage = HelloMessage | FocusUpdateMessage;
