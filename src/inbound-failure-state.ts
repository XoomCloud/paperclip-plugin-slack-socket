import type { PluginContext } from '@paperclipai/plugin-sdk';
import { stateScope } from './constants.js';
import type { FileFailure } from './inbound-storage.js';

/** Persist replay suppression in host state, not only the worker's memory. */
export function createInboundFailureState(ctx: Pick<PluginContext, 'state'>) {
  return {
    readFailure: async (key: string): Promise<FileFailure | null> => {
      const value = await ctx.state.get(stateScope(key + ':failure')) as FileFailure | null;
      if (value && (typeof value.reason !== 'string' || typeof value.sourceTs !== 'string')) {
        throw new Error('Invalid persisted attachment failure');
      }
      return value;
    },
    writeFailure: async (key: string, value: FileFailure): Promise<void> => {
      await ctx.state.set(stateScope(key + ':failure'), value);
    },
    clearFailure: async (key: string): Promise<void> => {
      await ctx.state.delete(stateScope(key + ':failure'));
    },
  };
}
