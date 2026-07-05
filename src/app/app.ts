import { Component, OnInit, OnDestroy, inject, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import { LensService } from './services/lens.service';
import { MonitorService } from './services/monitor.service';
import { AudioService } from './services/audio.service';
import { LogService, LogEntry } from './services/log.service';
import { PlaybackService } from './services/playback.service';

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
  protected logStore = inject(LogService);
  protected playback = inject(PlaybackService);

  protected serverHost = 'ws://localhost:8080';

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

  private subs: Subscription[] = [];

  ngOnInit(): void {
    this.subs.push(
      // /monitor events feed the log store.
      this.monitor.events$.subscribe(msg => this.logStore.append(msg)),
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
    this.playback.stop();
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

  clearLog(): void { this.logStore.clear(); }

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

  playRawAudio(base64: string): void {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    this.audio.playPcm16(bytes.buffer as ArrayBuffer);
  }

  toggleEntryPlayback(entry: LogEntry): void {
    if (this.playback.playingEntryId() === entry.id) this.playback.stop();
    else this.playback.play(entry);
  }
}
