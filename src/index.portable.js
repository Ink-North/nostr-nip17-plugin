import { defineBundledChannelEntry, loadBundledEntryExportSync } from 'openclaw/plugin-sdk/channel-entry-contract';

function createNostrProfileHttpHandler() {
  return loadBundledEntryExportSync(import.meta.url, {
    specifier: './api.js',
    exportName: 'createNostrProfileHttpHandler',
  });
}

function getNostrRuntime() {
  return loadBundledEntryExportSync(import.meta.url, {
    specifier: './api.js',
    exportName: 'getNostrRuntime',
  })();
}

function resolveNostrAccount(params) {
  return loadBundledEntryExportSync(import.meta.url, {
    specifier: './api.js',
    exportName: 'resolveNostrAccount',
  })(params);
}

const entry = defineBundledChannelEntry({
  id: 'nostr-nip17',
  name: 'Nostr NIP-17',
  description: 'OpenClaw Nostr DM channel plugin with NIP-04, NIP-17, and multi-account support',
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: './api.js',
    exportName: 'nostrPlugin',
  },
  runtime: {
    specifier: './api.js',
    exportName: 'setNostrRuntime',
  },
  registerFull(api) {
    const httpHandler = createNostrProfileHttpHandler()({
      getConfigProfile: (accountId) => {
        return resolveNostrAccount({
          cfg: getNostrRuntime().config.loadConfig(),
          accountId,
        }).profile;
      },
      updateConfigProfile: async (accountId, profile) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.loadConfig();
        const channels = cfg.channels ?? {};
        const nostrConfig = channels.nostr ?? {};
        await runtime.config.writeConfigFile({
          ...cfg,
          channels: {
            ...channels,
            nostr: {
              ...nostrConfig,
              profile,
            },
          },
        });
      },
      getAccountInfo: (accountId) => {
        const account = resolveNostrAccount({
          cfg: getNostrRuntime().config.loadConfig(),
          accountId,
        });
        if (!account.configured || !account.publicKey) return null;
        return {
          pubkey: account.publicKey,
          relays: account.relays,
        };
      },
      log: api.logger,
    });
    api.registerHttpRoute({
      path: '/api/channels/nostr',
      auth: 'gateway',
      match: 'prefix',
      gatewayRuntimeScopeSurface: 'trusted-operator',
      handler: httpHandler,
    });
  },
});

export default entry;
