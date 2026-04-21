# Nostr NIP-17 for OpenClaw

OpenClaw channel plugin for Nostr direct messages with support for both legacy NIP-04 DMs and modern NIP-17 gift-wrapped DMs.

## Features
- inbound and outbound NIP-04 direct messages
- inbound and outbound NIP-17 gift-wrapped direct messages
- multi-account support under `plugins.entries.nostr-nip17.config.accounts`
- standard OpenClaw pairing and DM policy integration
- plugin-owned relay subscriptions per configured account

## Install

### ClawHub
Install from ClawHub when published.

### npm
```bash
npm install @openclaw/nostr-nip17
```

## Minimum host version
- OpenClaw `2026.4.12` or newer

## Config
Default account stays in `channels.nostr`.
Additional accounts live under the plugin entry.

```json
{
  "channels": {
    "nostr": {
      "enabled": true,
      "name": "Cody",
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["wss://relay.damus.io", "wss://nos.lol"],
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1..."]
    }
  },
  "plugins": {
    "entries": {
      "nostr-nip17": {
        "enabled": true,
        "config": {
          "accounts": {
            "ink": {
              "enabled": true,
              "name": "Ink",
              "privateKey": "${NOSTR_INK_PRIVATE_KEY}",
              "relays": ["wss://relay.damus.io", "wss://nos.lol"],
              "dmPolicy": "allowlist",
              "allowFrom": ["npub1..."],
              "nip04Enabled": true,
              "nip17Enabled": true,
              "outboundMode": "nip17"
            }
          }
        }
      }
    }
  }
}
```

## Release notes
This package is intended to ship as a bundled channel entry using OpenClaw's plugin SDK imports only.
