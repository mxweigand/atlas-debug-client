import { Component, OnInit, OnDestroy, signal, inject, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import { LensService } from './services/lens.service';
import { MonitorService } from './services/monitor.service';
import { AudioService } from './services/audio.service';
import { ServerMessage } from './protocol/messages';
import { AUDIO_FORMAT } from './protocol/audio';

interface TranscriptDelta {
  delta: string;
  audioOffsetMs: number;
}

interface LogEntry {
  id: number;
  time: string;
  type: string;
  detail: string;
  audio?: string;
  audioStartWallclockMs?: number;
  deltas?: TranscriptDelta[];
}

@Component({
  selector: 'app-root',
  imports: [FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit, OnDestroy {
  protected lens = inject(LensService);
  protected monitor = inject(MonitorService);
  protected audio = inject(AudioService);

  protected serverHost = 'ws://localhost:8080';
  protected log = signal<LogEntry[]>([]);

  protected lensState = toSignal(this.lens.state$, { initialValue: 'disconnected' as const });
  protected monitorState = toSignal(this.monitor.state$, { initialValue: 'disconnected' as const });
  protected micActive = toSignal(this.audio.micActive$, { initialValue: false });
  protected mode = toSignal(this.monitor.mode$, {
    initialValue: this.monitor.mode$.getValue(),
  });

  /** True when this debug client currently holds the /lens slot. */
  protected weOwnLens = computed(() => this.lensState() === 'connected');
  /** True when a real HoloLens holds the /lens slot. */
  protected hololensOnLens = computed(() => this.mode().lensClient === 'hololens');

  protected playingEntryId = signal<number | null>(null);
  protected playingTimeMs = signal<number>(0);

  private subs: Subscription[] = [];
  private logIdCounter = 0;
  private lastUserSpeechId = -1;
  private lastAssistantSpeechId = -1;
  private pendingAssistantTranscript: string | null = null;
  private pendingDeltas: TranscriptDelta[] = [];
  private currentAudio: HTMLAudioElement | null = null;
  private currentAudioRaf = 0;

  ngOnInit(): void {
    this.subs.push(
      // /monitor events become log entries in the UI.
      this.monitor.events$.subscribe(msg => this.appendLog(msg)),
      // Assistant audio only ever arrives on /lens.
      this.lens.incomingAudio$.subscribe(buf => this.audio.playPcm16(buf)),
      // Mic chunks go into the lens socket (only effective while we hold the slot).
      this.audio.pcmChunk$.subscribe(buf => this.lens.sendAudio(buf)),
    );
    // Auto-connect /monitor — read-only, safe to keep open alongside a HoloLens.
    this.monitor.connect(`${this.serverHost}/monitor`);
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
    this.stopPlayback();
    this.lens.disconnect();
    this.monitor.disconnect();
  }

  reconnectMonitor(): void {
    this.monitor.connect(`${this.serverHost}/monitor`);
  }

  toggleLens(): void {
    if (this.lensState() === 'connected') {
      this.lens.disconnect();
    } else {
      this.lens.connect(`${this.serverHost}/lens`);
    }
  }

  clearLog(): void { this.log.set([]); }

  async toggleMic(): Promise<void> {
    if (this.micActive()) {
      this.audio.stopMic();
      return;
    }
    // No /lens slot, no mic — otherwise the audio would go nowhere.
    if (!this.weOwnLens()) {
      this.lens.connect(`${this.serverHost}/lens`);
      await new Promise(r => setTimeout(r, 300));
      if (this.lensState() !== 'connected') return;
    }
    await this.audio.startMic();
  }

  playAudio(base64: string): void {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    this.audio.playPcm16(bytes.buffer as ArrayBuffer);
  }

  /**
   * Play back the user audio of a log entry and track its position live so
   * the associated transcription deltas can be highlighted with a cursor.
   * Builds a WAV container around the PCM16 blob so HTMLAudioElement gives us
   * `currentTime` updates out of the box.
   */
  playUserSpeech(entry: LogEntry): void {
    if (!entry.audio) return;
    this.stopPlayback();

    const pcm = Uint8Array.from(atob(entry.audio), c => c.charCodeAt(0));
    const wav = pcm16ToWav(pcm, AUDIO_FORMAT.sampleRate);
    const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));

    const audio = new Audio(url);
    this.currentAudio = audio;
    this.playingEntryId.set(entry.id);
    this.playingTimeMs.set(0);

    const tick = (): void => {
      if (this.currentAudio !== audio) return;
      this.playingTimeMs.set(audio.currentTime * 1000);
      this.currentAudioRaf = requestAnimationFrame(tick);
    };

    audio.addEventListener('play', () => tick());
    audio.addEventListener('ended', () => { this.stopPlayback(); URL.revokeObjectURL(url); });
    audio.addEventListener('error', () => { this.stopPlayback(); URL.revokeObjectURL(url); });
    void audio.play().catch(() => this.stopPlayback());
  }

  stopPlayback(): void {
    if (this.currentAudioRaf) cancelAnimationFrame(this.currentAudioRaf);
    this.currentAudioRaf = 0;
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    this.playingEntryId.set(null);
    this.playingTimeMs.set(0);
  }

  /** Active delta index for a user_speech row, based on the player's currentTime. */
  protected activeDeltaIndex(entry: LogEntry): number {
    if (this.playingEntryId() !== entry.id || !entry.deltas) return -1;
    const t = this.playingTimeMs();
    let idx = -1;
    for (let i = 0; i < entry.deltas.length; i++) {
      if (entry.deltas[i].audioOffsetMs <= t) idx = i;
      else break;
    }
    return idx;
  }

  private appendLog(msg: ServerMessage): void {
    const time = new Date().toLocaleTimeString('de-DE');

    if (msg.type === 'user_transcript_delta') {
      const incoming: TranscriptDelta = { delta: msg.delta, audioOffsetMs: msg.audioOffsetMs };
      if (this.lastUserSpeechId >= 0) {
        this.log.update(l => l.map(e =>
          e.id === this.lastUserSpeechId
            ? { ...e, deltas: [...(e.deltas ?? []), incoming] }
            : e,
        ));
      } else {
        this.pendingDeltas.push(incoming);
      }
      return;
    }

    if (msg.type === 'user_transcript') {
      this.log.update(l => l.map(e =>
        e.id === this.lastUserSpeechId ? { ...e, detail: msg.transcript } : e,
      ));
      return;
    }
    if (msg.type === 'assistant_transcript') {
      if (this.lastAssistantSpeechId >= 0) {
        this.log.update(l => l.map(e =>
          e.id === this.lastAssistantSpeechId ? { ...e, detail: msg.transcript } : e,
        ));
      } else {
        this.pendingAssistantTranscript = msg.transcript;
      }
      return;
    }

    let detail = '';
    let audio: string | undefined;
    let audioStartWallclockMs: number | undefined;
    let deltas: TranscriptDelta[] | undefined;

    if (msg.type === 'tool_call') detail = `${msg.name}  ${JSON.stringify(msg.args)}`;
    else if (msg.type === 'tool_result') detail = `${msg.name}  ->  ${JSON.stringify(msg.result)}`;
    else if (msg.type === 'error') detail = msg.message;
    else if (msg.type === 'mode_changed') {
      detail = `lens: ${msg.lensClient ?? 'free'}  monitors: ${msg.monitorClients}`;
    }
    else if (msg.type === 'response_started') this.lastAssistantSpeechId = -1;
    else if (msg.type === 'speech_started') {
      this.pendingDeltas = [];
      this.lastUserSpeechId = -1;
    }
    else if (msg.type === 'user_speech') {
      audio = msg.audio;
      audioStartWallclockMs = msg.audioStartWallclockMs;
      if (this.pendingDeltas.length > 0) {
        deltas = this.pendingDeltas;
        this.pendingDeltas = [];
      }
    }
    else if (msg.type === 'assistant_speech') {
      audio = msg.audio;
      if (this.pendingAssistantTranscript !== null) {
        detail = this.pendingAssistantTranscript;
        this.pendingAssistantTranscript = null;
      }
    }

    const id = this.logIdCounter++;
    if (msg.type === 'user_speech') this.lastUserSpeechId = id;
    if (msg.type === 'assistant_speech') this.lastAssistantSpeechId = id;
    this.log.update(l => [
      ...l.slice(-199),
      { id, time, type: msg.type, detail, audio, audioStartWallclockMs, deltas },
    ]);
  }
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
