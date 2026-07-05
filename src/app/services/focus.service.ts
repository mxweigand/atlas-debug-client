import { Injectable, OnDestroy, effect, signal, inject } from '@angular/core';
import { LensService } from './lens.service';

const HEARTBEAT_MS = 250;

/**
 * Maintains the current focus target the user is emulating and pushes it to
 * the atlas-server on /lens. Semantics: send on every change (so the server
 * sees the delta instantly) plus a low-rate heartbeat with the current value
 * so the server knows we are still alive and still pointing at the same target.
 */
@Injectable({ providedIn: 'root' })
export class FocusService implements OnDestroy {
  private lens = inject(LensService);
  readonly current = signal<string | null>(null);

  private heartbeatHandle = 0;

  constructor() {
    effect(() => {
      // Change-triggered: signal read + immediate send.
      const value = this.current();
      this.emit(value);
    });
    this.heartbeatHandle = window.setInterval(() => this.emit(this.current()), HEARTBEAT_MS);
  }

  setFocus(id: string | null): void {
    this.current.set(id);
  }

  ngOnDestroy(): void {
    if (this.heartbeatHandle) clearInterval(this.heartbeatHandle);
  }

  private emit(value: string | null): void {
    if (!this.lens.isConnected) return;
    this.lens.sendMessage({ type: 'focus_update', wallclockMs: Date.now(), focusId: value });
  }
}
