import { Injectable, signal } from '@angular/core';
import { AUDIO_FORMAT } from '../protocol/audio';
import { LogEntry, TranscriptDelta } from './log.service';

/**
 * Plays back a user_speech clip and tracks its position so the transcription
 * deltas can be highlighted with a running cursor. Wraps the raw PCM16 blob in
 * a WAV container so the browser's HTMLAudioElement can consume it (which in
 * turn gives us `currentTime` updates for free).
 */
@Injectable({ providedIn: 'root' })
export class PlaybackService {
  /** Entry currently being played back. Null when idle. */
  readonly playingEntryId = signal<number | null>(null);
  /** Playback position within the current entry, in milliseconds. */
  readonly playingTimeMs = signal<number>(0);

  private currentAudio: HTMLAudioElement | null = null;
  private currentUrl: string | null = null;
  private rafHandle = 0;

  play(entry: LogEntry): void {
    if (!entry.audio) return;
    this.stop();

    const pcm = Uint8Array.from(atob(entry.audio), c => c.charCodeAt(0));
    const wav = pcm16ToWav(pcm, AUDIO_FORMAT.sampleRate);
    const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    const audio = new Audio(url);

    this.currentAudio = audio;
    this.currentUrl = url;
    this.playingEntryId.set(entry.id);
    this.playingTimeMs.set(0);

    const tick = (): void => {
      if (this.currentAudio !== audio) return;
      this.playingTimeMs.set(audio.currentTime * 1000);
      this.rafHandle = requestAnimationFrame(tick);
    };

    audio.addEventListener('play', () => tick());
    audio.addEventListener('ended', () => this.stop());
    audio.addEventListener('error', () => this.stop());
    void audio.play().catch(() => this.stop());
  }

  stop(): void {
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
    this.playingEntryId.set(null);
    this.playingTimeMs.set(0);
  }

  /**
   * Index of the delta whose audioOffsetMs the playhead has just reached.
   * -1 while the entry is not being played or before the first delta.
   */
  activeDeltaIndex(entry: LogEntry): number {
    if (this.playingEntryId() !== entry.id || !entry.deltas) return -1;
    const t = this.playingTimeMs();
    return lastLeqIndex(entry.deltas, t);
  }
}

/** Last index i such that deltas[i].audioOffsetMs <= t, or -1 if none. */
function lastLeqIndex(deltas: TranscriptDelta[], t: number): number {
  let idx = -1;
  for (let i = 0; i < deltas.length; i++) {
    if (deltas[i].audioOffsetMs <= t) idx = i;
    else break;
  }
  return idx;
}

/** Wrap a PCM16 mono blob in a WAV container so the browser Audio API accepts it. */
function pcm16ToWav(pcm: Uint8Array, sampleRate: number): ArrayBuffer {
  const dataLen = pcm.byteLength;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  let p = 0;
  const writeStr = (s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i));
  };
  writeStr('RIFF');
  view.setUint32(p, 36 + dataLen, true); p += 4;
  writeStr('WAVE');
  writeStr('fmt ');
  view.setUint32(p, 16, true); p += 4;
  view.setUint16(p, 1, true); p += 2;
  view.setUint16(p, 1, true); p += 2;
  view.setUint32(p, sampleRate, true); p += 4;
  view.setUint32(p, sampleRate * 2, true); p += 4;
  view.setUint16(p, 2, true); p += 2;
  view.setUint16(p, 16, true); p += 2;
  writeStr('data');
  view.setUint32(p, dataLen, true); p += 4;
  new Uint8Array(buf, 44).set(pcm);
  return buf;
}
