/** Injectable fetch so real providers can be unit tested without network. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function audioBlob(audio: Buffer, mime: string): Blob {
  return new Blob([new Uint8Array(audio)], { type: mime || 'application/octet-stream' });
}

export function extensionFor(mime: string): string {
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  return 'bin';
}
