import {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  buildChannelOutboundSessionRoute,
  formatPairingApproveHint,
  stripChannelTargetPrefix,
} from 'openclaw/plugin-sdk/core';
import {
  createDefaultChannelRuntimeState,
  collectStatusIssuesFromLastError,
  createComputedAccountStatusAdapter,
} from 'openclaw/plugin-sdk/status-helpers';
import {
  dispatchInboundDirectDmWithRuntime,
  resolveInboundDirectDmAccessWithRuntime,
} from 'openclaw/plugin-sdk/direct-dm';
import { createChatChannelPlugin } from 'openclaw/plugin-sdk/channel-core';
import { createChannelPairingController } from 'openclaw/plugin-sdk/channel-pairing';
import { buildTrafficStatusSummary, buildPassiveChannelStatusSummary } from 'openclaw/plugin-sdk/extension-shared';
import { attachChannelToResult } from 'openclaw/plugin-sdk/channel-send-result';
import { createScopedChannelConfigAdapter, createScopedDmSecurityResolver } from 'openclaw/plugin-sdk/channel-config-helpers';
import { describeAccountSnapshot } from 'openclaw/plugin-sdk/account-helpers';
import { z } from 'openclaw/plugin-sdk/zod';
import { nip19, getPublicKey } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';
import { startDualNostrBus } from './dual-nostr-bus.mjs';

const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol'];
const activeBuses = new Map();

function normalizePubkeyLocal(input) {
  const trimmed = String(input || '').trim().replace(/^nostr:/i, '');
  if (!trimmed) return '';
  if (trimmed.startsWith('npub1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== 'npub') throw new Error('Invalid npub');
    const data = decoded.data;
    const hex = typeof data === 'string' ? data.toLowerCase() : Buffer.from(data).toString('hex').toLowerCase();
    return nip19.npubEncode(hex);
  }
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return nip19.npubEncode(trimmed.toLowerCase());
  throw new Error('Pubkey must be 64 hex characters or npub format');
}

function pubkeyHexLocal(input) {
  const trimmed = String(input || '').trim().replace(/^nostr:/i, '');
  if (!trimmed) return '';
  if (trimmed.startsWith('npub1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== 'npub') throw new Error('Invalid npub');
    const data = decoded.data;
    return typeof data === 'string' ? data.toLowerCase() : Buffer.from(data).toString('hex').toLowerCase();
  }
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  throw new Error('Pubkey must be 64 hex characters or npub format');
}

function normalizePrivateKeyHex(privateKey) {
  const trimmed = String(privateKey || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('nsec1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== 'nsec') throw new Error('Invalid nsec');
    const data = decoded.data;
    if (typeof data === 'string') return data.toLowerCase();
    return Buffer.from(data).toString('hex').toLowerCase();
  }
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  throw new Error('Private key must be nsec or 64-char hex');
}

function normalizeAllowEntry(entry) {
  const trimmed = String(entry || '').trim();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  return pubkeyHexLocal(trimmed);
}

function isSenderAllowed(senderPubkey, allowFrom = []) {
  const normalizedSender = pubkeyHexLocal(senderPubkey);
  for (const entry of allowFrom) {
    const normalized = normalizeAllowEntry(entry);
    if (normalized === '*' || normalized === normalizedSender) return true;
  }
  return false;
}

const DualNostrConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  privateKey: z.any().optional(),
  relays: z.array(z.string()).optional(),
  dmPolicy: z.string().optional(),
  allowFrom: z.array(z.string()).optional(),
  profile: z.any().optional(),
  nip04Enabled: z.boolean().optional(),
  nip17Enabled: z.boolean().optional(),
  outboundMode: z.enum(['nip04', 'nip17', 'auto']).optional(),
}).passthrough();


function resolveNostrOutboundSessionRoute(params) {
  const target = stripChannelTargetPrefix(params.target, 'nostr');
  if (!target) return null;
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: 'nostr',
    accountId: params.accountId,
    peer: { kind: 'direct', id: target },
    chatType: 'direct',
    from: `nostr:${target}`,
    to: `nostr:${target}`,
  });
}

function resolvePluginConfig(cfg) {
  return cfg?.plugins?.entries?.['nostr-nip17']?.config ?? {};
}

function resolvePluginAccounts(cfg) {
  const pluginCfg = resolvePluginConfig(cfg);
  const accounts = pluginCfg.accounts;
  return accounts && typeof accounts === 'object' && !Array.isArray(accounts) ? accounts : {};
}

function listAccountIds(cfg) {
  const accountIds = new Set([DEFAULT_ACCOUNT_ID]);
  const accounts = resolvePluginAccounts(cfg);
  for (const key of Object.keys(accounts)) {
    const trimmed = String(key || '').trim();
    if (trimmed && trimmed !== DEFAULT_ACCOUNT_ID) accountIds.add(trimmed);
  }
  return [...accountIds];
}

function resolveAccountConfig(cfg, accountId = DEFAULT_ACCOUNT_ID) {
  const channelCfg = cfg?.channels?.nostr ?? {};
  if (accountId === DEFAULT_ACCOUNT_ID) return channelCfg;
  return resolvePluginAccounts(cfg)?.[accountId] ?? {};
}

function resolveAccount(cfg, accountId = DEFAULT_ACCOUNT_ID) {
  const nostrCfg = resolveAccountConfig(cfg, accountId);
  const privateKey = nostrCfg.privateKey?.value ?? nostrCfg.privateKey ?? '';
  const privateKeyHex = normalizePrivateKeyHex(privateKey);
  const publicKey = privateKeyHex ? getPublicKey(hexToBytes(privateKeyHex)) : '';
  return {
    accountId,
    name: nostrCfg.name,
    enabled: nostrCfg.enabled !== false,
    configured: Boolean(privateKeyHex),
    privateKey,
    publicKey,
    relays: Array.isArray(nostrCfg.relays) && nostrCfg.relays.length ? nostrCfg.relays : DEFAULT_RELAYS,
    profile: nostrCfg.profile,
    config: nostrCfg,
  };
}

async function resolveDirectAccess({ cfg, senderPubkey, rawBody, runtime, account }) {
  return resolveInboundDirectDmAccessWithRuntime({
    cfg,
    channel: 'nostr',
    accountId: account.accountId,
    dmPolicy: account.config.dmPolicy ?? 'pairing',
    allowFrom: account.config.allowFrom,
    senderId: senderPubkey,
    rawBody,
    isSenderAllowed,
    runtime: {
      shouldComputeCommandAuthorized: runtime.channel.commands.shouldComputeCommandAuthorized,
      resolveCommandAuthorizedFromAuthorizers: runtime.channel.commands.resolveCommandAuthorizedFromAuthorizers,
    },
    modeWhenAccessGroupsOff: 'configured',
  });
}

export function createLocalDualNostrPlugin(runtimeProvider) {
  return createChatChannelPlugin({
    base: {
      id: 'nostr',
      meta: {
        id: 'nostr',
        label: 'Nostr',
        selectionLabel: 'Nostr',
        docsPath: '/channels/nostr',
        docsLabel: 'nostr',
        blurb: 'Decentralized DMs via Nostr relays (NIP-04 + NIP-17)',
        order: 100,
      },
      capabilities: {
        chatTypes: ['direct'],
        media: false,
      },
      reload: { configPrefixes: ['channels.nostr', 'plugins.entries.nostr-nip17'] },
      configSchema: buildChannelConfigSchema(DualNostrConfigSchema),
      config: {
        ...createScopedChannelConfigAdapter({
          sectionKey: 'nostr',
          listAccountIds: (cfg) => listAccountIds(cfg),
          resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId ?? DEFAULT_ACCOUNT_ID),
          defaultAccountId: () => DEFAULT_ACCOUNT_ID,
          clearBaseFields: ['name', 'privateKey', 'relays', 'dmPolicy', 'allowFrom', 'profile', 'nip04Enabled', 'nip17Enabled', 'outboundMode'],
          resolveAllowFrom: (account) => account.config.allowFrom,
          formatAllowFrom: (allowFrom) => (allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean),
          allowTopLevel: true,
        }),
        isConfigured: (account) => account.configured,
        describeAccount: (account) => describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: { publicKey: account.publicKey },
        }),
      },
      messaging: {
        normalizeTarget: (target) => normalizePubkeyLocal(target),
        targetResolver: {
          looksLikeId: (input) => {
            const trimmed = input.trim();
            return trimmed.startsWith('npub1') || /^[0-9a-fA-F]{64}$/.test(trimmed);
          },
          hint: '<npub|hex pubkey|nostr:npub...>',
        },
        resolveOutboundSessionRoute: (params) => resolveNostrOutboundSessionRoute(params),
      },
      status: { ...createComputedAccountStatusAdapter({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        collectStatusIssues: (accounts) => collectStatusIssuesFromLastError('nostr', accounts),
        buildChannelSummary: ({ snapshot }) => buildPassiveChannelStatusSummary(snapshot, { publicKey: snapshot.publicKey ?? null }),
        resolveAccountSnapshot: ({ account, runtime }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            publicKey: account.publicKey,
            profile: account.profile,
            ...buildTrafficStatusSummary(runtime),
          },
        }),
      }) },
      gateway: {
        startAccount: async (ctx) => {
          const account = ctx.account ?? resolveAccount(ctx.cfg, ctx.accountId ?? DEFAULT_ACCOUNT_ID);
          ctx.setStatus?.({ accountId: account.accountId, publicKey: account.publicKey });
          ctx.log?.info?.(`[${account.accountId}] starting Nostr provider (pubkey: ${account.publicKey})`);
          if (!account.configured) throw new Error('Nostr private key not configured');
          const runtime = runtimeProvider();
          const pairing = createChannelPairingController({ core: runtime, channel: 'nostr', accountId: account.accountId });

          const resolveInboundAccess = async (senderPubkey, rawBody) => await resolveDirectAccess({
            cfg: ctx.cfg,
            senderPubkey,
            rawBody,
            runtime,
            account,
          });

          let busHandle = null;
          const bus = await startDualNostrBus({
            accountId: account.accountId,
            privateKey: account.privateKey,
            relays: account.relays,
            nip04Enabled: account.config.nip04Enabled !== false,
            nip17Enabled: account.config.nip17Enabled !== false,
            outboundMode: account.config.outboundMode === 'nip04' ? 'nip04' : 'nip17',
            authorizeSender: async ({ senderPubkey, reply }) => {
              const senderNpub = normalizePubkeyLocal(senderPubkey);
              const resolved = await resolveInboundAccess(senderNpub, '');
              if (resolved.access.decision === 'allow') return 'allow';
              if ((account.config.dmPolicy ?? 'pairing') === 'pairing') {
                await pairing.issueChallenge({
                  senderId: senderNpub,
                  senderIdLine: `Your Nostr pubkey: ${senderNpub}`,
                  sendPairingReply: reply,
                  onCreated: () => {},
                  onReplyError: (err) => ctx.log?.warn?.(`[${account.accountId}] nostr pairing reply failed for ${senderNpub}: ${String(err)}`),
                });
              } else {
                ctx.log?.debug?.(`[${account.accountId}] blocked Nostr sender ${senderNpub} (${resolved.access.reason})`);
              }
              return 'deny';
            },
            onMessage: async (senderPubkey, text, reply, meta) => {
              const normalizedSender = normalizePubkeyLocal(senderPubkey);
              ctx.log?.debug?.(`[${account.accountId}] inbound ${meta.mode} dm from ${normalizedSender} event=${meta.eventId}`);
              const resolvedAccess = await resolveInboundAccess(normalizedSender, text);
              if (resolvedAccess.access.decision !== 'allow') {
                ctx.log?.warn?.(`[${account.accountId}] dropping Nostr DM after preflight drift (${normalizedSender}, ${resolvedAccess.access.reason})`);
                return;
              }
              await dispatchInboundDirectDmWithRuntime({
                cfg: ctx.cfg,
                runtime,
                channel: 'nostr',
                channelLabel: 'Nostr',
                accountId: account.accountId,
                peer: { kind: 'direct', id: normalizedSender },
                senderId: normalizedSender,
                senderAddress: `nostr:${normalizedSender}`,
                recipientAddress: `nostr:${account.publicKey}`,
                conversationLabel: normalizedSender,
                rawBody: text,
                messageId: meta.eventId,
                timestamp: meta.createdAt * 1000,
                commandAuthorized: resolvedAccess.commandAuthorized,
                deliver: async (payload) => {
                  const outboundText = payload && typeof payload === 'object' && 'text' in payload ? payload.text ?? '' : '';
                  if (!outboundText.trim()) return;
                  await reply(outboundText);
                },
                onRecordError: (err) => {
                  ctx.log?.error?.(`[${account.accountId}] failed recording Nostr inbound session: ${String(err)}`);
                },
                onDispatchError: (err, info) => {
                  ctx.log?.error?.(`[${account.accountId}] Nostr ${info.kind} reply failed: ${String(err)}`);
                },
              });
            },
            onError: (error, where) => ctx.log?.error?.(`[${account.accountId}] Nostr error (${where}): ${error?.message ?? String(error)}`),
            onConnect: (relay) => ctx.log?.debug?.(`[${account.accountId}] Connected to relay: ${relay}`),
            onDisconnect: (relay) => ctx.log?.debug?.(`[${account.accountId}] Disconnected from relay: ${relay}`),
            onEose: (relays) => ctx.log?.debug?.(`[${account.accountId}] EOSE received from relays: ${relays}`),
            onDebug: (msg) => ctx.log?.debug?.(`[${account.accountId}] bus ${msg}`),
            onMetric: () => {
              if (busHandle?.getMetrics) {
              }
            },
          });
          busHandle = bus;
          activeBuses.set(account.accountId, bus);
          ctx.log?.info?.(`[${account.accountId}] Nostr provider started, connected to ${account.relays.length} relay(s)`);
          await new Promise((resolve) => {
            const onAbort = () => resolve();
            if (ctx.abortSignal?.aborted) return resolve();
            ctx.abortSignal?.addEventListener?.('abort', onAbort, { once: true });
          });
          bus.close();
          activeBuses.delete(account.accountId);
          ctx.log?.info?.(`[${account.accountId}] Nostr provider stopped`);
        },
      },
    },
    pairing: {
      text: {
        idLabel: 'nostrPubkey',
        message: 'Your pairing request has been approved!',
        normalizeAllowEntry: (entry) => normalizeAllowEntry(entry) ?? String(entry || '').trim(),
        notify: async ({ id, message, accountId }) => {
          const bus = activeBuses.get(accountId ?? DEFAULT_ACCOUNT_ID);
          if (bus) await bus.send({ toPubkey: normalizePubkeyLocal(id), text: message, mode: 'nip17' });
        },
        approveHint: formatPairingApproveHint,
      },
    },
    security: {
      resolveDmPolicy: createScopedDmSecurityResolver({
        channelKey: 'nostr',
        resolvePolicy: (account) => account.config.dmPolicy,
        resolveAllowFrom: (account) => account.config.allowFrom,
        policyPathSuffix: 'dmPolicy',
        defaultPolicy: 'pairing',
        approveHint: formatPairingApproveHint('nostr'),
        normalizeEntry: (raw) => normalizeAllowEntry(raw) ?? String(raw || '').trim(),
      }),
    },
    outbound: {
      deliveryMode: 'direct',
      textChunkLimit: 4000,
      sendText: async ({ cfg, to, text, accountId }) => {
        const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
        const bus = activeBuses.get(resolvedAccountId);
        if (!bus) throw new Error('Nostr bus not running');
        const account = resolveAccount(cfg, resolvedAccountId);
        const mode = account.config.outboundMode === 'nip04' ? 'nip04' : 'nip17';
        const normalizedTo = normalizePubkeyLocal(to);
        await bus.send({ toPubkey: normalizedTo, text: text ?? '', mode });
        return attachChannelToResult('nostr', { to: normalizedTo, messageId: `nostr-${Date.now()}` });
      },
    },
  });
}
