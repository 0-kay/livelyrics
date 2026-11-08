import type { TranscriptionProvider } from '@livelyrics/shared';
import { audioBlob, extensionFor, ProviderError, type FetchLike } from './http.js';

export interface WhisperOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** OpenAI audio transcription API (Whisper). */
export class WhisperTranscriptionProvider implements TranscriptionProvider {
  private readonly fetch: FetchLike;

  constructor(private readonly opts: WhisperOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  async transcribe(audio: Buffer, mime: string): Promise<string> {
    const form = new FormData();
    form.set('model', this.opts.model ?? 'whisper-1');
    form.set('response_format', 'json');
    form.set('file', audioBlob(audio, mime), `chunk.${extensionFor(mime)}`);
    const res = await this.fetch(`${this.opts.baseUrl ?? 'https://api.openai.com'}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new ProviderError(`OpenAI HTTP ${res.status}`, 'whisper', res.status);
    const body = (await res.json()) as { text?: string };
    return (body.text ?? '').trim();
  }
}
