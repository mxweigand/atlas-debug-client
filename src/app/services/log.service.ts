import { Injectable, signal } from '@angular/core';
import { ServerMessage } from '../protocol/messages';

export interface TranscriptDelta {
  delta: string;
  audioOffsetMs: number;
}

export interface LogEntry {
  id: number;
  time: string;
  type: string;
  detail: string;
  audio?: string;
  audioStartWallclockMs?: number;
  itemId?: string;
  deltas?: TranscriptDelta[];
  /**
   * Per-delta deixis annotations, keyed by deltaIndex. Populated when a
   * resolve_deixis tool_result comes in. Value is the resolved focusId
   * (or null when the reference could not be resolved).
   */
  deixisMarks?: Map<number, string | null>;
}

interface ResolveDeixisResolution {
  phrase: string;
  focusId: string | null;
  itemId: string | null;
  deltaIndex: number | null;
  spokenAtMs: number | null;
  focusEventTimeMs: number | null;
  confidence: 'high' | 'medium' | 'low';
  error?: string;
}

const MAX_ENTRIES = 200;

/**
 * Consumes ServerMessages from the monitor socket and turns them into a
 * scrollable, structured log. Every user_speech row is keyed by its OpenAI
 * conversation item id so we can splice matching transcripts and deltas onto
 * the same entry regardless of arrival order. resolve_deixis tool results
 * carry itemId+deltaIndex too and paint markers back onto their user_speech row.
 */
@Injectable({ providedIn: 'root' })
export class LogService {
  readonly entries = signal<LogEntry[]>([]);

  private idCounter = 0;
  /** Fast lookup: OpenAI item id -> entry id of the user_speech row. */
  private entryIdByItemId = new Map<string, number>();
  /** Deltas that arrived before their user_speech entry existed. Keyed by itemId. */
  private pendingDeltasByItemId = new Map<string, TranscriptDelta[]>();
  /** Transcripts that arrived before their user_speech entry existed. Keyed by itemId. */
  private pendingTranscriptsByItemId = new Map<string, string>();
  /** Deixis marks buffered for a user_speech entry that hasn't arrived yet. */
  private pendingDeixisByItemId = new Map<string, Map<number, string | null>>();
  /** Track the current assistant_speech row so a late assistant_transcript can land on it. */
  private lastAssistantEntryId = -1;
  private pendingAssistantTranscript: string | null = null;

  clear(): void {
    this.entries.set([]);
    this.entryIdByItemId.clear();
    this.pendingDeltasByItemId.clear();
    this.pendingTranscriptsByItemId.clear();
    this.pendingDeixisByItemId.clear();
    this.lastAssistantEntryId = -1;
    this.pendingAssistantTranscript = null;
  }

  append(msg: ServerMessage): void {
    switch (msg.type) {
      case 'user_transcript_delta':
        this.handleDelta(msg.itemId, { delta: msg.delta, audioOffsetMs: msg.audioOffsetMs });
        return;
      case 'user_transcript':
        this.handleUserTranscript(msg.itemId, msg.transcript);
        return;
      case 'assistant_transcript':
        this.handleAssistantTranscript(msg.transcript);
        return;
      case 'user_speech':
        this.pushEntry({
          type: 'user_speech',
          audio: msg.audio,
          audioStartWallclockMs: msg.audioStartWallclockMs,
          itemId: msg.itemId,
          deltas: this.pendingDeltasByItemId.get(msg.itemId),
          detail: this.pendingTranscriptsByItemId.get(msg.itemId) ?? '',
          deixisMarks: this.pendingDeixisByItemId.get(msg.itemId),
        });
        this.pendingDeltasByItemId.delete(msg.itemId);
        this.pendingTranscriptsByItemId.delete(msg.itemId);
        this.pendingDeixisByItemId.delete(msg.itemId);
        return;
      case 'assistant_speech': {
        const detail = this.pendingAssistantTranscript ?? '';
        this.pendingAssistantTranscript = null;
        this.pushEntry({ type: 'assistant_speech', audio: msg.audio, detail });
        return;
      }
      case 'response_started':
        this.lastAssistantEntryId = -1;
        this.pushEntry({ type: 'response_started' });
        return;
      case 'tool_call':
        this.pushEntry({ type: 'tool_call', detail: `${msg.name}  ${JSON.stringify(msg.args)}` });
        return;
      case 'tool_result':
        if (msg.name === 'resolve_deixis') this.handleDeixisResult(msg.result);
        this.pushEntry({ type: 'tool_result', detail: `${msg.name}  ->  ${JSON.stringify(msg.result)}` });
        return;
      case 'error':
        this.pushEntry({ type: 'error', detail: msg.message });
        return;
      case 'mode_changed':
        this.pushEntry({
          type: 'mode_changed',
          detail: `lens: ${msg.lensClient ?? 'free'}  monitors: ${msg.monitorClients}`,
        });
        return;
      case 'focus_update':
        // Intentionally not logged — the heartbeat runs at ~4 Hz and would
        // drown out every other event. Live focus is visible in the sidebar.
        return;
      case 'speech_started':
      case 'speech_ended':
      case 'response_done':
        this.pushEntry({ type: msg.type });
        return;
    }
  }

  private handleDelta(itemId: string, delta: TranscriptDelta): void {
    const entryId = this.entryIdByItemId.get(itemId);
    if (entryId === undefined) {
      const pending = this.pendingDeltasByItemId.get(itemId) ?? [];
      pending.push(delta);
      this.pendingDeltasByItemId.set(itemId, pending);
      return;
    }
    this.entries.update(list => list.map(e =>
      e.id === entryId ? { ...e, deltas: [...(e.deltas ?? []), delta] } : e,
    ));
  }

  private handleUserTranscript(itemId: string, transcript: string): void {
    const entryId = this.entryIdByItemId.get(itemId);
    if (entryId === undefined) {
      this.pendingTranscriptsByItemId.set(itemId, transcript);
      return;
    }
    this.entries.update(list => list.map(e =>
      e.id === entryId ? { ...e, detail: transcript } : e,
    ));
  }

  private handleAssistantTranscript(transcript: string): void {
    if (this.lastAssistantEntryId < 0) {
      this.pendingAssistantTranscript = transcript;
      return;
    }
    this.entries.update(list => list.map(e =>
      e.id === this.lastAssistantEntryId ? { ...e, detail: transcript } : e,
    ));
  }

  private handleDeixisResult(result: unknown): void {
    if (!result || typeof result !== 'object') return;
    const resolutions = (result as { resolutions?: ResolveDeixisResolution[] }).resolutions;
    if (!Array.isArray(resolutions)) return;
    for (const r of resolutions) {
      if (r.itemId == null || r.deltaIndex == null) continue;
      this.markDeixis(r.itemId, r.deltaIndex, r.focusId);
    }
  }

  private markDeixis(itemId: string, deltaIndex: number, focusId: string | null): void {
    const entryId = this.entryIdByItemId.get(itemId);
    if (entryId === undefined) {
      const pending = this.pendingDeixisByItemId.get(itemId) ?? new Map();
      pending.set(deltaIndex, focusId);
      this.pendingDeixisByItemId.set(itemId, pending);
      return;
    }
    this.entries.update(list => list.map(e => {
      if (e.id !== entryId) return e;
      const marks = new Map(e.deixisMarks);
      marks.set(deltaIndex, focusId);
      return { ...e, deixisMarks: marks };
    }));
  }

  private pushEntry(partial: Partial<LogEntry> & { type: string }): void {
    const id = this.idCounter++;
    const entry: LogEntry = {
      id,
      time: new Date().toLocaleTimeString('de-DE'),
      detail: '',
      ...partial,
    };
    if (entry.type === 'user_speech' && entry.itemId) {
      this.entryIdByItemId.set(entry.itemId, id);
    }
    if (entry.type === 'assistant_speech') {
      this.lastAssistantEntryId = id;
    }
    this.entries.update(list => {
      const next = [...list.slice(-(MAX_ENTRIES - 1)), entry];
      if (list.length >= MAX_ENTRIES) {
        const evicted = list[0];
        if (evicted?.itemId) this.entryIdByItemId.delete(evicted.itemId);
      }
      return next;
    });
  }
}
