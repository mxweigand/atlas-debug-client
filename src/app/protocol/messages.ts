// Wire protocol between atlas-server and its clients (HoloLens + debug client).
// This file is the master. Clients have to follow it exactly. Possibly by keeping a copy of it if they implement it directly in TypeScript.

// ─── Project / object shapes (shared data model) ──────────────────────────────

/**
 * A single addressable object inside a project. `id` doubles as the focusId
 * emitted on /lens — the same value the deixis resolver returns. `summary` is
 * short, injected verbatim into the system prompt at session start. `content`
 * is the full description, retrieved on demand via the describe_object tool.
 * `geometry` is opaque JSON reserved for future use (position, mesh, …).
 *
 * The parent project is not stored on the object — it's implicit from where
 * the object lives (either its JSON file or the active project).
 */
export interface AtlasObject {
  id: string;
  name: string;
  summary: string;
  content: string;
  geometry: unknown;
}

/**
 * A named collection of objects. `summary` is an optional project-level intro
 * also injected into the system prompt at session start.
 */
export interface AtlasProject {
  id: string;
  name: string;
  summary?: string;
}

// ─── Server -> Client (broadcast on /lens and /monitor as appropriate) ────────

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
 * Complete PCM16 audio (base64) of the user turn from speech_started to
 * speech_ended, plus the wallclock timestamp of the recording anchor (t=0
 * of the audio blob) and the OpenAI conversation item id that keys the
 * transcript and every delta for this turn. Monitor-only.
 */
export interface UserSpeechMessage {
  type: 'user_speech';
  itemId: string;
  audio: string;
  audioStartWallclockMs: number;
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
 * `audioStartWallclockMs` of the same turn.
 */
export interface UserTranscriptDeltaMessage {
  type: 'user_transcript_delta';
  itemId: string;
  delta: string;
  wallclockMs: number;
  audioOffsetMs: number;
}

/**
 * Current connection topology. Broadcast to /monitor whenever the /lens slot
 * or the /monitor client set changes. `lensClient` is 'hololens' when the
 * lens slot is occupied by a real HoloLens (path /lens with role hint),
 * 'debug' when it's the debug client emulating, and null when free.
 */
export interface ModeChangedMessage {
  type: 'mode_changed';
  lensClient: 'hololens' | 'debug' | null;
  monitorClients: number;
}

/**
 * Rebroadcast of a focus_update the server received on /lens. Sent to
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
 * Sent to /monitor and /lens so both stay in sync with the server state.
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
  | ObjectUpdatedMessage;

// ─── Client -> Server ─────────────────────────────────────────────────────────

/**
 * Sent once by clients connecting to /lens to declare their identity.
 * If omitted, the server assumes 'debug'. Purely informational — the server
 * treats both roles identically.
 */
export interface HelloMessage {
  type: 'hello';
  role: 'hololens' | 'debug';
}

/**
 * Continuous pointing/focus stream from the lens client. Emitted on change
 * plus a low-rate heartbeat so the server always knows whether the pointer is
 * still on the same target. `focusId` is null when the user is not pointing
 * at any known object. `wallclockMs` is the client's Date.now() at capture
 * — the server aligns it against transcript delta timestamps to resolve
 * deictic references.
 */
export interface FocusUpdateMessage {
  type: 'focus_update';
  wallclockMs: number;
  focusId: string | null;
}

export type ClientMessage = HelloMessage | FocusUpdateMessage;
