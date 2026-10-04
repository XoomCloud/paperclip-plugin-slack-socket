import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';
import type { SlackFile } from './types.js';
import { FileAccessError, inboundFileLimit } from './inbound-files.js';

export interface StoredFile {
  id: string; name: string; mimetype: string; size: number; path: string;
  attachmentId?: string; issueId?: string; attachmentPendingIssueId?: string;
  source?: { channel: string; ts: string; conversation: string }; sha256?: string;
}
export interface FileSource { agentId: string; channel: string; ts: string; conversation: string; historical?: boolean; threadTs?: string }
export interface FileFailure { reason: string; sourceTs: string }
class RememberedFileFailure extends FileAccessError {}
export interface InboundStorageDeps {
  root: string;
  maxBytes?: number;
  download(file: SlackFile, maxBytes: number): Promise<Uint8Array>;
  readCache(key: string): Promise<StoredFile | null>;
  writeCache(key: string, file: StoredFile): Promise<void>;
  readFailure?(key: string): Promise<FileFailure | null>;
  writeFailure?(key: string, failure: FileFailure): Promise<void>;
  clearFailure?(key: string): Promise<void>;
  boundIssue(source: FileSource): Promise<string | null>;
  attach(issueId: string, file: StoredFile, bytes: Uint8Array, recoverOnly?: boolean): Promise<string>;
  notify(source: FileSource, text: string): Promise<void>;
}

/** Root is provisioned by IT with a service owner and one read-only employee ACL. */
export async function storePrivateFile(root: string, source: FileSource, file: SlackFile, bytes: Uint8Array): Promise<StoredFile> {
  if (!/^[a-f0-9-]{36}$/.test(source.agentId) || !/^F[A-Z0-9]+$/.test(file.id)) throw new Error('Invalid storage identity');
  const base = join(root, source.agentId);
  if (await realpath(base) !== base || !(await lstat(base)).isDirectory()) throw new Error('Storage is not provisioned');
  const dir = join(base, randomUUID());
  await mkdir(dir, { mode: 0o750 }); // inherits employee read/traverse ACL, never employee write
  const name = file.name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 180) || file.id;
  const path = join(dir, `${file.id}-${name}`);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return { id: file.id, name: file.name.slice(0, 200), mimetype: file.mimetype.slice(0, 100), size: bytes.byteLength, path,
    source: { channel: source.channel, ts: source.ts, conversation: source.conversation },
    sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function fileCacheKey(source: FileSource, file: SlackFile): string {
  return 'inbound-file:' + createHash('sha256').update(JSON.stringify([source.agentId, source.conversation, file.id])).digest('hex');
}

export function createInboundFilePreparer(deps: InboundStorageDeps) {
  const active = new Map<string, Promise<StoredFile>>();
  const failures = new Map<string, FileFailure>();
  const cap = inboundFileLimit(deps.maxBytes);
  async function prepareOne(file: SlackFile, source: FileSource): Promise<StoredFile> {
    const key = fileCacheKey(source, file);
    const pending = active.get(key);
    if (pending) return pending;
    const work = (async () => {
      const previous = failures.get(key) ?? (deps.readFailure ? await deps.readFailure(key) : undefined);
      // History rehydration is not a request to retry a failed attachment.
      // A new message containing the same file explicitly retries it.
      if (previous && (source.historical || previous.sourceTs === source.ts)) {
        throw new RememberedFileFailure(previous.reason);
      }
      try {
      if (file.size !== undefined && file.size > cap) throw new FileAccessError(`File exceeds the ${cap / 1024 / 1024} MiB attachment limit.`);
      let record = await deps.readCache(key);
      if (record && (!record.path.startsWith(join(deps.root, source.agentId) + sep) || await realpath(record.path).catch(() => '') !== record.path)) record = null;
      if (!record) {
        const bytes = await deps.download(file, cap);
        if (bytes.byteLength > cap) throw new FileAccessError(`File exceeds the ${cap / 1024 / 1024} MiB attachment limit.`);
        record = await storePrivateFile(deps.root, source, file, bytes);
        // Persist before remote upload, so a failed upload does not redownload the Slack file.
        await deps.writeCache(key, record);
      }
      const issueId = await deps.boundIssue(source);
      if (issueId && record.issueId !== issueId) {
        const handle = await open(record.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let bytes: Uint8Array;
        try { bytes = await handle.readFile(); } finally { await handle.close(); }
        const recoverOnly = record.attachmentPendingIssueId === issueId;
        record = { ...record, attachmentPendingIssueId: issueId };
        await deps.writeCache(key, record);
        record = { ...record, issueId, attachmentId: await deps.attach(issueId, record, bytes, recoverOnly), attachmentPendingIssueId: undefined };
        await deps.writeCache(key, record);
      }
      if (deps.clearFailure) await deps.clearFailure(key);
      failures.delete(key);
      return record;
      } catch (error) {
        const reason = error instanceof FileAccessError ? error.message : 'File storage or task attachment failed. Please ask IT to check file delivery.';
        const failure = { reason, sourceTs: source.ts };
        failures.set(key, failure);
        if (deps.writeFailure) await deps.writeFailure(key, failure);
        // Notify only for files attached to the current message. The shared
        // in-flight promise reserves notification once for concurrent turns.
        if (!source.historical) {
          const detail = reason.replace(/\s*The message text is still available\.?/g, '').trim();
          await deps.notify(source, `An attachment could not be read. ${detail} Your message text is still available. Reattach the file to retry.`).catch(() => {});
        }
        throw new RememberedFileFailure(reason);
      }
    })();
    active.set(key, work);
    try { return await work; } finally { active.delete(key); }
  }
  return async (files: SlackFile[], source: FileSource): Promise<string> => {
    const lines: string[] = [];
    if (files.length > 10 && !source.historical) await deps.notify(source, 'Only the first 10 attachments can be read in one message. Please send the remaining files separately.');
    for (const file of files.slice(0, 10)) {
      try {
        const record = await prepareOne(file, source);
        lines.push(JSON.stringify({ ...record, durableEvidence: Boolean(record.attachmentId) }));
      } catch (error) {
        const reason = error instanceof FileAccessError ? error.message : 'File storage or task attachment failed. Please ask IT to check file delivery.';
        if (!(error instanceof RememberedFileFailure) && !source.historical) {
          await deps.notify(source, `File delivery could not be prepared. Your message text is still available. Please ask IT to check it.`).catch(() => {});
        }
        lines.push(JSON.stringify({ id: file.id, available: false, reason }));
      }
    }
    return lines.join('\n');
  };
}

