import type { FileSource } from './inbound-storage.js';
import type { SlackFile, ThreadMessage } from './types.js';
import { buildThreadContext } from './thread-transcript.js';

/** Run after history hydration completes, so timed-out history cannot download in the background. */
export async function prepareInboundTurn(input: {
  current: SlackFile[]; history: ThreadMessage[]; agentId: string;
  channel: string; ts: string; conversation: string; threadTs?: string;
  prepareFiles?: (files: SlackFile[], source: FileSource) => Promise<string>;
  reading(): Promise<void>;
}): Promise<string> {
  const seen = new Set<string>();
  const entries: Array<{ files: SlackFile[]; ts: string; historical: boolean }> = [];
  let omitted = 0;
  function select(files: SlackFile[], ts: string, historical: boolean) {
    const chosen = files.filter(file => {
      if (seen.has(file.id)) return false;
      if (seen.size >= 10) { omitted++; return false; }
      seen.add(file.id); return true;
    });
    if (chosen.length) entries.push({ files: chosen, ts, historical });
  }
  select(input.current, input.ts, false);
  for (const message of [...input.history].reverse()) select(message.files ?? [], message.ts, true);
  if (entries.some(entry => !entry.historical)) await input.reading();
  const evidence: string[] = [];
  for (const entry of entries) {
    try {
      if (!input.prepareFiles) throw new Error('File intake unavailable');
      const reference = await input.prepareFiles(entry.files, {
        agentId: input.agentId, channel: input.channel, ts: entry.ts,
        conversation: input.conversation, historical: entry.historical, threadTs: input.threadTs,
      });
      evidence.push(JSON.stringify({ sourceTs: entry.ts, historical: entry.historical }) + '\n' + reference);
    } catch {
      for (const file of entry.files) evidence.push(JSON.stringify({ id: file.id, available: false, reason: 'File intake unavailable. Do not claim to have read the file.' }));
    }
  }
  if (omitted) evidence.push(JSON.stringify({ omittedFiles: omitted, reason: 'Only ten unique files can be opened per turn; send remaining files separately.' }));
  if (!evidence.length) return '';
  // Filename, metadata and unavailable reasons are untrusted, like message history.
  return '\n' + buildThreadContext([{ label: 'Slack attachment evidence', text: evidence.join('\n') }], 0);
}
