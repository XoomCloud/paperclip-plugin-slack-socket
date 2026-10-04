import type { SlackFile } from './types.js';

/** Normalize untrusted Slack API objects without passing arbitrary fields to agents. */
export function mapSlackFiles(value: unknown): SlackFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const f = entry as Record<string, unknown>;
    if (typeof f.id !== 'string' || !/^F[A-Z0-9]+$/.test(f.id)) return [];
    return [{
      id: f.id,
      name: typeof f.name === 'string' ? f.name : f.id,
      mimetype: typeof f.mimetype === 'string' ? f.mimetype : 'application/octet-stream',
      size: typeof f.size === 'number' && Number.isSafeInteger(f.size) && f.size >= 0 ? f.size : undefined,
      url_private: typeof f.url_private === 'string' ? f.url_private : undefined,
    }];
  });
}

export class FileAccessError extends Error {}
export const DEFAULT_INBOUND_FILE_MAX_BYTES = 10 * 1024 * 1024;
const SUPPORTED_TYPES = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'text/plain', 'text/csv', 'text/markdown', 'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
export function inboundFileLimit(value?: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= 10 * 1024 * 1024
    ? value : DEFAULT_INBOUND_FILE_MAX_BYTES;
}

/** Token remains solely in the gateway. No URLs, response bodies or secrets in errors. */
export async function downloadSlackFile(
  file: SlackFile, token: string, maxBytes: number,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  const cap = inboundFileLimit(maxBytes);
  if (!SUPPORTED_TYPES.has(file.mimetype.toLowerCase())) throw new FileAccessError('Unsupported attachment type. Please send a PDF, image, text file or Office document.');
  if (file.size !== undefined && file.size > cap) throw new FileAccessError(`File exceeds the ${cap / 1024 / 1024} MiB attachment limit.`);
  let url: URL;
  try { url = new URL(file.url_private ?? ''); }
  catch { throw new FileAccessError('Slack did not provide a downloadable file.'); }
  // Do not send a bot token to a URL supplied by an attacker or follow a redirect with it.
  if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new FileAccessError('Slack supplied an unsupported file location.');
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  try {
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: abort.signal,
    });
    if (!response.ok || !response.body) throw new FileAccessError('Slack file download failed. Please check file access and the files:read permission.');
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > cap) {
      await response.body.cancel();
      throw new FileAccessError(`File exceeds the ${cap / 1024 / 1024} MiB attachment limit.`);
    }
    if ((response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html') && file.mimetype !== 'text/html') {
      await response.body.cancel();
      throw new FileAccessError('Slack returned a sign-in page instead of the file.');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > cap) {
          await reader.cancel();
          throw new FileAccessError(`File exceeds the ${cap / 1024 / 1024} MiB attachment limit.`);
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    if (error instanceof FileAccessError) throw error;
    throw new FileAccessError('Slack file download failed or timed out. The message text is still available.');
  } finally { clearTimeout(timer); }
}

