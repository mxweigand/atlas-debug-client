// Audio format between atlas-server and its clients (HoloLens + debug client).
// Both sides must use these exact values — mismatches cause distorted audio.
// This file is the master. Clients have to follow it exactly. Possibly by keeping a copy of it if they implement it directly in TypeScript. 
export const AUDIO_FORMAT = {
  sampleRate: 24_000,
  channels: 1,
  bitDepth: 16,
  // 20ms × 24000 Hz × 2 bytes = 960 bytes per chunk
  chunkDurationMs: 20,
} as const;
