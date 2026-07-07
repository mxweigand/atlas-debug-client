import { Component, OnInit, OnDestroy, inject, computed, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import { HololensService } from './services/hololens.service';
import { MonitorService } from './services/monitor.service';
import { AudioService } from './services/audio.service';
import { LogService, LogEntry } from './services/log.service';
import { PlaybackService } from './services/playback.service';
import { FocusService } from './services/focus.service';
import { ProjectsService } from './services/projects.service';
import { AtlasObject } from './protocol/messages';

@Component({
  selector: 'app-root',
  imports: [],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit, OnDestroy {
  protected hololens = inject(HololensService);
  protected monitor = inject(MonitorService);
  protected audio = inject(AudioService);
  protected logStore = inject(LogService);
  protected playback = inject(PlaybackService);
  protected focus = inject(FocusService);
  protected projectsService = inject(ProjectsService);

  // Hardcoded during local development. In the final HoloLens build these will
  // come from a config file or discovery step.
  private readonly serverHost = 'ws://localhost:8080';
  private readonly restBase = 'http://localhost:3000';

  protected hololensState = toSignal(this.hololens.state$, { initialValue: 'disconnected' as const });
  protected monitorState = toSignal(this.monitor.state$, { initialValue: 'disconnected' as const });
  protected micActive = toSignal(this.audio.micActive$, { initialValue: false });
  protected mode = toSignal(this.monitor.mode$, {
    initialValue: this.monitor.mode$.getValue(),
  });

  /** True when this debug client currently holds the /hololens slot. */
  protected weOwnHololens = computed(() => this.hololensState() === 'connected');
  /** True when a real HoloLens (not the debug emulator) holds the /hololens slot. */
  protected realHololensConnected = computed(() => this.mode().hololensClient === 'hololens');

  protected projects = computed(() => this.projectsService.projects());
  protected activeProject = computed(() => this.projectsService.active());

  /** Objects the focus panel renders. Empty when no project active. */
  protected activeObjects = computed(() => this.projectsService.active()?.objects ?? []);

  /** Entries whose object body is expanded in the right panel. */
  private expandedObjectIds = signal<Set<string>>(new Set());

  private subs: Subscription[] = [];

  ngOnInit(): void {
    this.projectsService.setRestBase(this.restBase);
    this.subs.push(
      // /monitor events feed the log store.
      this.monitor.events$.subscribe(msg => this.logStore.append(msg)),
      // /monitor also carries the project/object state stream — reload details
      // on activation, patch in place on object updates.
      this.monitor.events$.subscribe(msg => {
        if (msg.type === 'project_activated') {
          if (msg.projectId) void this.projectsService.reloadActive(msg.projectId);
          else this.projectsService.active.set(null);
        } else if (msg.type === 'object_updated') {
          this.projectsService.applyObjectUpdate(msg.projectId, msg.object);
        } else if (msg.type === 'object_created') {
          this.projectsService.applyObjectCreate(msg.projectId, msg.object);
        } else if (msg.type === 'object_deleted') {
          this.projectsService.applyObjectDelete(msg.projectId, msg.objectId);
        }
      }),
      // Assistant audio only ever arrives on /hololens.
      this.hololens.incomingAudio$.subscribe(buf => this.audio.playPcm16(buf)),
      // Mic chunks go into the /hololens socket (only effective while we hold the slot).
      this.audio.pcmChunk$.subscribe(buf => this.hololens.sendAudio(buf)),
    );
    // Auto-connect /monitor — read-only, safe to keep open alongside a real HoloLens.
    this.monitor.connect(`${this.serverHost}/monitor`);
    // Pull the project list right away so the right panel is populated even
    // before any monitor event arrives.
    void this.projectsService.refreshList();
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
    this.playback.stop();
    this.hololens.disconnect();
    this.monitor.disconnect();
  }

  toggleHololens(): void {
    if (this.hololensState() === 'connected') {
      this.hololens.disconnect();
    } else {
      this.hololens.connect(`${this.serverHost}/hololens`);
    }
  }

  clearLog(): void { this.logStore.clear(); }

  async toggleMic(): Promise<void> {
    if (this.micActive()) {
      this.audio.stopMic();
      return;
    }
    // No /hololens slot, no mic — otherwise the audio would go nowhere.
    if (!this.weOwnHololens()) {
      this.hololens.connect(`${this.serverHost}/hololens`);
      await new Promise(r => setTimeout(r, 300));
      if (this.hololensState() !== 'connected') return;
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

  hoverFocus(id: string): void { this.focus.setFocus(id); }
  clearFocus(): void { this.focus.setFocus(null); }

  async activateProject(id: string): Promise<void> {
    await this.projectsService.activate(id);
  }

  async deactivateProject(): Promise<void> {
    await this.projectsService.deactivate();
  }

  async refreshProjects(): Promise<void> {
    await this.projectsService.refreshList();
  }

  isObjectExpanded(id: string): boolean {
    return this.expandedObjectIds().has(id);
  }

  toggleObjectExpanded(id: string): void {
    const next = new Set(this.expandedObjectIds());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expandedObjectIds.set(next);
  }

  objectAsJsonLines(obj: AtlasObject): string[] {
    // Split by newline so each key/value pair gets its own block box in the
    // template — enables a per-source-line hanging indent on wrap.
    return JSON.stringify(
      { name: obj.name, summary: obj.summary, content: obj.content, geometry: obj.geometry },
      null,
      2,
    ).split('\n');
  }

  /**
   * Entries whose JSON block is currently collapsed. Default is expanded, so
   * this set holds only the ones the user has explicitly folded away.
   */
  private collapsedIds = signal<Set<number>>(new Set());

  isJsonCollapsed(id: number): boolean {
    return this.collapsedIds().has(id);
  }

  toggleJsonCollapsed(id: number): void {
    const next = new Set(this.collapsedIds());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.collapsedIds.set(next);
  }

  prettyJson(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
}
