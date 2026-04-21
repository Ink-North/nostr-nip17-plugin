import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { z } from 'openclaw/plugin-sdk/zod';
import { createLocalDualNostrPlugin } from './local-dual-nostr-plugin.mjs';

let runtimeRef = null;

export function setNostrRuntime(runtime) {
  runtimeRef = runtime;
  try {
    import('./api.js').then((mod) => mod?.setPortableNostrRuntime?.(runtime)).catch(() => {});
  } catch {}
}

export const nostrPlugin = createLocalDualNostrPlugin(() => {
  if (!runtimeRef) throw new Error('Nostr runtime not set');
  return runtimeRef;
});

const pluginConfigSchema = z.object({
  accounts: z.record(z.string(), z.object({
    enabled: z.boolean().optional(),
    name: z.string().optional(),
    privateKey: z.any().optional(),
    relays: z.array(z.string()).optional(),
    dmPolicy: z.string().optional(),
    allowFrom: z.array(z.string()).optional(),
    profile: z.any().optional(),
    nip04Enabled: z.boolean().optional(),
    nip17Enabled: z.boolean().optional(),
    outboundMode: z.enum(['nip04', 'nip17', 'auto']).optional(),
  }).passthrough()).optional(),
}).passthrough();

const entry = defineChannelPluginEntry({
  id: 'nostr-nip17',
  name: 'Nostr NIP-17',
  description: 'OpenClaw Nostr DM channel plugin with NIP-04, NIP-17, and multi-account support',
  plugin: nostrPlugin,
  configSchema: pluginConfigSchema,
  setRuntime: setNostrRuntime,
});

export default entry;
