import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { ClientMessage, ServerMessage, HelloMessage } from '../protocol/messages';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'rejected';

/**
 * WebSocket connection to the atlas-server on `/hololens`. Emulates a real
 * HoloLens: pushes microphone PCM out, receives assistant audio and lifecycle
 * events. Only one connection per server instance — if the slot is taken, the
 * server closes the connection with code 1008 and we surface state `rejected`.
 */
@Injectable({ providedIn: 'root' })
export class HololensService {
  private ws: WebSocket | null = null;

  readonly state$ = new BehaviorSubject<ConnectionState>('disconnected');
  readonly events$ = new Subject<ServerMessage>();
  readonly incomingAudio$ = new Subject<ArrayBuffer>();

  connect(url: string): void {
    if (this.ws) this.disconnect();
    this.state$.next('connecting');

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.state$.next('connected');
      // Declare the role so the server broadcasts 'debug' in mode_changed.
      const hello: HelloMessage = { type: 'hello', role: 'debug' };
      ws.send(JSON.stringify(hello));
    };
    ws.onclose = (ev) => {
      this.ws = null;
      // 1008 = slot occupied; surface it as its own state for the UI.
      this.state$.next(ev.code === 1008 ? 'rejected' : 'disconnected');
    };
    ws.onerror = () => {
      this.ws = null;
      this.state$.next('disconnected');
    };
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.incomingAudio$.next(event.data);
      } else if (typeof event.data === 'string') {
        try { this.events$.next(JSON.parse(event.data) as ServerMessage); }
        catch { /* ignore malformed */ }
      }
    };

    this.ws = ws;
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  sendAudio(pcm16: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm16);
    }
  }

  /** Send a JSON text frame on the /hololens socket. No-op when disconnected. */
  sendMessage(msg: ClientMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  /** True when the /hololens socket is currently open. */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
