---
summary: "OpenClaw Nostr DM plugin with NIP-04, NIP-17, and multi-account support"
read_when:
  - You want OpenClaw to receive DMs via Nostr
  - You want one default Nostr identity plus additional plugin-owned accounts
  - You are preparing this plugin for portable packaging or publishing
title: "Nostr NIP-17"
---

# Nostr NIP-17

OpenClaw channel plugin for Nostr direct messages.

## Features
- NIP-04 direct messages
- NIP-17 direct messages
- per-account DM policy and allowlist
- one default account from `channels.nostr`
- additional accounts from `plugins.entries.nostr-nip17.config.accounts`
- one active Nostr bus per configured account

## Config

### Default account

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
  }
}
```

### Additional accounts

```json
{
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
              "allowFrom": ["npub1..."]
            }
          }
        }
      }
    }
  }
}
```

## Behavior
- `channels.nostr` remains stock-compatible and acts as the default account.
- extra accounts are plugin-owned to avoid conflicts with the stock Nostr channel schema.
- outbound sends use the selected account bus.
- pairing and DM authorization are resolved per account.

## Accepted key formats
- private keys: `nsec...` or 64-char hex
- allowlist entries: `npub...` or 64-char hex

## Portability note
Portable package entrypoints are provided in `src/index.portable.js` and `src/setup-entry.portable.js` and are now the package default. The development implementation still exists separately for local runtime work.
