import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { ModeChangedMessage, ServerMessage } from '../protocol/messages';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

const INITIAL_MODE: ModeChangedMessage = {
  type: 'mode_changed',
  hololensClient: null,
  monitorClients: 0,
};

/**
 * Read-only WebSocket connection to the atlas-server on `/monitor`. Receives
 * the debug streams (user_speech blobs, deltas, transcripts, mode_changed).
 * Sends nothing.
 */
@Injectable({ providedIn: 'root' })
export class MonitorService {
  private ws: WebSocket | null = null;

  readonly state$ = new BehaviorSubject<ConnectionState>('disconnected');
  readonly events$ = new Subject<ServerMessage>();
  readonly mode$ = new BehaviorSubject<ModeChangedMessage>(INITIAL_MODE);

  connect(url: string): void {
    if (this.ws) this.disconnect();
    this.state$.next('connecting');

    const ws = new WebSocket(url);

    ws.onopen = () => this.state$.next('connected');
    ws.onclose = () => { this.ws = null; this.state$.next('disconnected'); };
    ws.onerror = () => { this.ws = null; this.state$.next('disconnected'); };
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const msg = JSON.parse(event.data) as ServerMessage;
        if (msg.type === 'mode_changed') this.mode$.next(msg);
        this.events$.next(msg);
      } catch { /* ignore malformed */ }
    };

    this.ws = ws;
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
}
