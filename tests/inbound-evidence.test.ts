import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createIssueBinder, uploadInboundEvidence } from '../src/inbound-evidence.js';
import { createInboundFailureState } from '../src/inbound-failure-state.js';
import { fileCacheKey } from '../src/inbound-storage.js';
import { makeCtx } from './helpers.js';
const file = { id: 'F123', name: 'test.pdf', mimetype: 'application/pdf', size: 3, path: '/private/file' };
const bytes = new Uint8Array([1, 2, 3]);
afterEach(() => vi.unstubAllGlobals());
describe('Paperclip attachment evidence contract', () => {
  it('reconciles an already uploaded digest without posting another attachment', async () => {
    const fetcher = vi.fn(async () => Response.json([{ id: 'attachment', originalFilename: 'F123-test.pdf', byteSize: 3, sha256: createHash('sha256').update(bytes).digest('hex') }]));
    vi.stubGlobal('fetch', fetcher);
    expect(await uploadInboundEvidence('http://localhost:3100', 'company', 'grant', 'issue', file, bytes, true)).toBe('attachment');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses the company/issue upload endpoint only after successful reconciliation', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(Response.json({ id: 'attachment' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await uploadInboundEvidence('http://localhost:3100', 'company', 'grant', 'issue', file, bytes)).toBe('attachment');
    expect(fetcher.mock.calls[1]![0]).toBe('http://localhost:3100/api/companies/company/issues/issue/attachments');
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(fetcher.mock.calls[1]![1].body).toBeInstanceOf(FormData);
  });
  it('never posts if reconciliation is unavailable', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 503 })); vi.stubGlobal('fetch', fetcher);
    await expect(uploadInboundEvidence('http://localhost:3100', 'company', 'grant', 'issue', file, bytes)).rejects.toThrow(/reconciliation/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('requires a configured bridge grant before network access', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(uploadInboundEvidence('http://localhost:3100', 'company', '', 'issue', file, bytes)).rejects.toThrow(/grant/); expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses the same durable key across worker recreation but not across employees', async () => {
    const { ctx } = makeCtx(); const source = { agentId: 'employee-A', channel: 'C1', ts: '1.0', conversation: 'scope' };
    const key = fileCacheKey(source, file), other = fileCacheKey({ ...source, agentId: 'employee-B' }, file);
    await createInboundFailureState(ctx).writeFailure(key, { reason: 'Unavailable', sourceTs: '1.0' });
    expect(await createInboundFailureState(ctx).readFailure(key)).toEqual({ reason: 'Unavailable', sourceTs: '1.0' });
    expect(await createInboundFailureState(ctx).readFailure(other)).toBeNull();
    await createInboundFailureState(ctx).clearFailure(key); expect(await createInboundFailureState(ctx).readFailure(key)).toBeNull();
  });
  it('binds concurrent intake to one backlog issue without starting an autonomous task', async () => {
    const { ctx } = makeCtx(); ctx.issues.list = vi.fn().mockResolvedValue([]);
    const binder = createIssueBinder(ctx, 'company'); const source = { agentId: 'employee', channel: 'C1', ts: '1.0', conversation: 'scope' };
    await Promise.all([binder(source), binder(source)]);
    expect(ctx.issues.create).toHaveBeenCalledTimes(1);
    expect(ctx.issues.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'backlog', assigneeAgentId: 'employee', originId: 'scope' }));
  });
});
