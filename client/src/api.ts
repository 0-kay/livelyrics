import type { HealthResponse, IdentifyResponse, TranscribeResponse } from '@livelyrics/shared';

export async function identify(clip: Blob, filename = 'clip.wav'): Promise<IdentifyResponse> {
  const form = new FormData();
  form.set('audio', clip, filename);
  const res = await fetch('/api/identify', { method: 'POST', body: form });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Server error ${res.status}`);
  }
  return (await res.json()) as IdentifyResponse;
}

export async function health(): Promise<HealthResponse> {
  const res = await fetch('/api/health');
  return (await res.json()) as HealthResponse;
}

export interface TranscribeFields {
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  positionMs: number;
}

/** Concert mode: transcribe a chunk and match it against the track's lyrics near positionMs. */
export async function transcribe(clip: Blob, f: TranscribeFields, filename = 'chunk.wav'): Promise<TranscribeResponse> {
  const form = new FormData();
  // Text fields go before the file so the server sees them first.
  form.set('title', f.title);
  form.set('artist', f.artist);
  if (f.album) form.set('album', f.album);
  form.set('durationMs', String(Math.round(f.durationMs)));
  form.set('positionMs', String(Math.round(f.positionMs)));
  form.set('audio', clip, filename);
  const res = await fetch('/api/transcribe', { method: 'POST', body: form });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Server error ${res.status}`);
  }
  return (await res.json()) as TranscribeResponse;
}
