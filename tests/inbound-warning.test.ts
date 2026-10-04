import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInboundFilePreparer, type FileFailure, type StoredFile } from '../src/inbound-storage.js';
import { FileAccessError } from '../src/inbound-files.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inbound-warning-'))); roots.push(root);
  const source = { agentId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', channel: 'C123', ts: '1.001', conversation: 'bot:A:session:C123:1.001' };
  await mkdir(join(root, source.agentId));
  const records = new Map<string, StoredFile>(), failures = new Map<string, FileFailure>();
  const deps = {
    root, download: vi.fn(async (): Promise<Uint8Array> => { throw new FileAccessError('Slack file download failed or timed out. The message text is still available.'); }),
    readCache: async (k: string) => records.get(k) ?? null,
    writeCache: async (k: string, v: StoredFile) => { records.set(k, v); },
    readFailure: async (k: string) => failures.get(k) ?? null,
    writeFailure: async (k: string, v: FileFailure) => { failures.set(k, v); },
    clearFailure: async (k: string) => { failures.delete(k); },
    boundIssue: async () => null, attach: vi.fn(async () => 'attachment'), notify: vi.fn(async (_source: unknown, _text: string) => {}),
  };
  const file = { id: 'F123', name: 'example.png', mimetype: 'image/png', size: 3 };
  return { source, file, deps, failures, prepare: createInboundFilePreparer(deps) };
}
describe('failed inbound attachment replay', () => {
  it('notifies once and skips the same failed event', async () => {
    const b = await setup(); await b.prepare([b.file], b.source); await b.prepare([b.file], b.source);
    expect(b.deps.download).toHaveBeenCalledTimes(1); expect(b.deps.notify).toHaveBeenCalledTimes(1);
    expect(b.deps.notify.mock.calls[0]![1].match(/message text is still available/g)).toHaveLength(1);
  });
  it('suppresses historical retries and warnings across a restart', async () => {
    const b = await setup(); await b.prepare([b.file], b.source);
    const restarted = createInboundFilePreparer(b.deps);
    const result = await restarted([b.file], { ...b.source, historical: true });
    expect(JSON.parse(result)).toMatchObject({ available: false });
    expect(b.deps.download).toHaveBeenCalledTimes(1); expect(b.deps.notify).toHaveBeenCalledTimes(1);
  });
  it('preserves unavailable evidence without notifying for a first historical failure', async () => {
    const b = await setup(); await b.prepare([b.file], { ...b.source, historical: true });
    await b.prepare([b.file], { ...b.source, historical: true });
    expect(b.deps.download).toHaveBeenCalledTimes(1); expect(b.deps.notify).not.toHaveBeenCalled();
  });
  it('allows a fresh attachment message to recover and clears the failure', async () => {
    const b = await setup(); await b.prepare([b.file], b.source);
    b.deps.download.mockImplementation(async () => new Uint8Array([1, 2, 3]));
    const recovered = JSON.parse(await b.prepare([b.file], { ...b.source, ts: '2.001' }));
    expect(recovered.available).not.toBe(false); expect(b.failures.size).toBe(0);
    await b.prepare([b.file], { ...b.source, historical: true });
    expect(b.deps.download).toHaveBeenCalledTimes(2);
  });
  it('deduplicates concurrent failures and notifications', async () => {
    const b = await setup(); await Promise.all([b.prepare([b.file], b.source), b.prepare([b.file], b.source)]);
    expect(b.deps.download).toHaveBeenCalledTimes(1); expect(b.deps.notify).toHaveBeenCalledTimes(1);
  });
  it('keeps failure state isolated between conversations', async () => {
    const b = await setup(); await b.prepare([b.file], b.source);
    await b.prepare([b.file], { ...b.source, conversation: 'bot:A:session:C123:2.001' });
    expect(b.deps.download).toHaveBeenCalledTimes(2); expect(b.failures.size).toBe(2);
  });
  it('remembers oversized files without attempting downloads', async () => {
    const b = await setup(); const large = { ...b.file, size: 11 * 1024 * 1024 };
    await b.prepare([large], b.source); await b.prepare([large], { ...b.source, historical: true });
    expect(b.deps.download).not.toHaveBeenCalled(); expect(b.deps.notify).toHaveBeenCalledTimes(1);
  });
});

