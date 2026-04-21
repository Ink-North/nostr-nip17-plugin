import { defineBundledChannelSetupEntry } from 'openclaw/plugin-sdk/channel-entry-contract';

const entry = defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: './api.js',
    exportName: 'nostrPlugin',
  },
});

export default entry;
