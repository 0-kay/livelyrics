import type { LyricsProvider, RecognitionProvider, TranscriptionProvider } from '@livelyrics/shared';
import type { AppConfig } from '../config.js';
import { MockLyricsProvider, MockRecognitionProvider, MockTranscriptionProvider } from './mock/index.js';
import { AcrCloudRecognitionProvider } from './real/acrcloud.js';
import { LrclibLyricsProvider } from './real/lrclib.js';
import { WhisperTranscriptionProvider } from './real/whisper.js';

export interface Providers {
  recognition: RecognitionProvider;
  lyrics: LyricsProvider;
  /** Optional in real mode: only needed for concert mode. */
  transcription: TranscriptionProvider | null;
}

export class MissingConfigError extends Error {
  constructor(readonly missing: string[]) {
    super(`PROVIDER_MODE=real requires: ${missing.join(', ')}`);
    this.name = 'MissingConfigError';
  }
}

export function createProviders(config: AppConfig): Providers {
  if (config.mode === 'mock') {
    // Recognition and transcription mocks follow the same virtual song so they agree.
    const virtualPlayback = { startedAtMs: Date.now(), rate: config.mockPlaybackRate };
    return {
      recognition: new MockRecognitionProvider({ virtualPlayback }),
      lyrics: new MockLyricsProvider(),
      transcription: new MockTranscriptionProvider({ virtualPlayback }),
    };
  }
  const { host, accessKey, accessSecret } = config.acrcloud;
  const missing = [
    !host && 'ACRCLOUD_HOST',
    !accessKey && 'ACRCLOUD_ACCESS_KEY',
    !accessSecret && 'ACRCLOUD_ACCESS_SECRET',
  ].filter((x): x is string => Boolean(x));
  if (missing.length) throw new MissingConfigError(missing);
  return {
    recognition: new AcrCloudRecognitionProvider({ host: host!, accessKey: accessKey!, accessSecret: accessSecret! }),
    lyrics: new LrclibLyricsProvider({ userAgent: config.lrclibUserAgent }),
    transcription: config.openaiApiKey ? new WhisperTranscriptionProvider({ apiKey: config.openaiApiKey }) : null,
  };
}

export * from './mock/index.js';
export { AcrCloudRecognitionProvider } from './real/acrcloud.js';
export { LrclibLyricsProvider } from './real/lrclib.js';
export { WhisperTranscriptionProvider } from './real/whisper.js';
