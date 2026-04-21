# Publishing Nostr NIP-17

## Release checklist
- confirm `openclaw.plugin.json` uses `kind: "bundled-channel-entry"`
- confirm `src/index.portable.js` exports id `nostr-nip17`
- confirm package metadata points at portable entrypoints
- confirm runtime dependencies are declared in `dependencies`
- verify load on OpenClaw `2026.4.12` or newer
- smoke test inbound and outbound DMs before publish

## Publish targets
- npm package: `@openclaw/nostr-nip17`
- ClawHub release: enable via package `openclaw.release.publishToClawHub`

## Recommended publish flow
1. bump version in `package.json`
2. test local load in OpenClaw
3. publish npm package
4. publish to ClawHub
5. verify install on a clean host

## Current packaging notes
- portable entrypoints are `src/index.portable.js` and `src/setup-entry.portable.js`
- plugin id is `nostr-nip17`
- channel id remains `nostr`
- default account config stays under `channels.nostr`
- additional plugin-owned accounts stay under `plugins.entries.nostr-nip17.config.accounts`
