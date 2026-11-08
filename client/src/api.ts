import type { HealthResponse, IdentifyResponse } from '@livelyrics/shared';

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
