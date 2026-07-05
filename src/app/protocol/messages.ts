// Wire protocol between atlas-server and its clients (HoloLens + debug client).
// This file is the master. Clients have to follow it exactly. Possibly by keeping a copy of it if they implement it directly in TypeScript. 

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
  | FocusUpdateBroadcastMessage;

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
