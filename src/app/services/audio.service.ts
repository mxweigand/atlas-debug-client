import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { AUDIO_FORMAT } from '../protocol/audio';

// ScriptProcessorNode buffer size must be a power of 2; 512 ≈ 21ms at 24kHz
const BUFFER_SIZE = 512;

@Injectable({ providedIn: 'root' })
export class AudioService {
  private ctx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private stream: MediaStream | null = null;
  private nextPlayTime = 0;

  readonly micActive$ = new BehaviorSubject<boolean>(false);
  readonly pcmChunk$ = new Subject<ArrayBuffer>();

  async startMic(): Promise<void> {
    this.ctx ??= new AudioContext({ sampleRate: AUDIO_FORMAT.sampleRate });
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const source = this.ctx.createMediaStreamSource(this.stream);

    this.processor = this.ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    this.processor.onaudioprocess = (e) => {
      this.pcmChunk$.next(floatToPcm16(e.inputBuffer.getChannelData(0)));
    };

    source.connect(this.processor);
    this.processor.connect(this.ctx.destination);
    this.micActive$.next(true);
  }

  stopMic(): void {
    this.processor?.disconnect();
    this.processor = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.micActive$.next(false);
  }

  playPcm16(data: ArrayBuffer): void {
    this.ctx ??= new AudioContext({ sampleRate: AUDIO_FORMAT.sampleRate });
    const float32 = pcm16ToFloat32(data);
    const audioBuffer = this.ctx.createBuffer(1, float32.length, AUDIO_FORMAT.sampleRate);
    audioBuffer.copyToChannel(float32, 0);

    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    if (this.nextPlayTime < now) this.nextPlayTime = now;
    source.start(this.nextPlayTime);
    this.nextPlayTime += audioBuffer.duration;
  }
}

function floatToPcm16(float32: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

function pcm16ToFloat32(data: ArrayBuffer): Float32Array<ArrayBuffer> {
  const view = new DataView(data);
  const out = new Float32Array(data.byteLength / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return out;
}
