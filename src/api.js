export { nostrPlugin, setNostrRuntime } from './index.mjs';
export { createLocalDualNostrPlugin } from './local-dual-nostr-plugin.mjs';

import { z } from 'openclaw/plugin-sdk/zod';
import { getPublicKey, SimplePool, verifyEvent } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';

const DEFAULT_ACCOUNT_ID = 'default';
const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol'];
const DEFAULT_TIMEOUT_MS = 5000;
let runtimeRef = null;

export function setPortableNostrRuntime(runtime) {
  runtimeRef = runtime;
}

export function getNostrRuntime() {
  if (runtimeRef) return runtimeRef;
  throw new Error('Nostr runtime not set');
}

function normalizePrivateKeyHex(privateKey) {
  const trimmed = String(privateKey || '').trim();
  if (!trimmed) return '';
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  return trimmed;
}

function contentToProfile(content) {
  if (!content || typeof content !== 'object') return {};
  return {
    name: typeof content.name === 'string' ? content.name : undefined,
    displayName: typeof content.display_name === 'string' ? content.display_name : (typeof content.displayName === 'string' ? content.displayName : undefined),
    about: typeof content.about === 'string' ? content.about : undefined,
    picture: typeof content.picture === 'string' ? content.picture : undefined,
    banner: typeof content.banner === 'string' ? content.banner : undefined,
    website: typeof content.website === 'string' ? content.website : undefined,
    nip05: typeof content.nip05 === 'string' ? content.nip05 : undefined,
    lud16: typeof content.lud16 === 'string' ? content.lud16 : undefined,
  };
}

const NostrProfileSchema = z.object({
  name: z.string().optional(),
  displayName: z.string().optional(),
  about: z.string().optional(),
  picture: z.string().optional(),
  banner: z.string().optional(),
  website: z.string().optional(),
  nip05: z.string().optional(),
  lud16: z.string().optional(),
}).passthrough();

export function resolveNostrAccount({ cfg, accountId = DEFAULT_ACCOUNT_ID } = {}) {
  const channelCfg = cfg?.channels?.nostr ?? {};
  const pluginAccounts = cfg?.plugins?.entries?.['nostr-nip17']?.config?.accounts ?? {};
  const nostrCfg = accountId === DEFAULT_ACCOUNT_ID ? channelCfg : (pluginAccounts?.[accountId] ?? {});
  const privateKey = nostrCfg?.privateKey?.value ?? nostrCfg?.privateKey ?? '';
  const privateKeyHex = normalizePrivateKeyHex(privateKey);
  let publicKey = '';
  try {
    if (privateKeyHex && /^[0-9a-f]{64}$/i.test(privateKeyHex)) publicKey = getPublicKey(hexToBytes(privateKeyHex));
  } catch {}
  const relays = Array.isArray(nostrCfg?.relays) && nostrCfg.relays.length ? nostrCfg.relays : DEFAULT_RELAYS;
  return {
    accountId,
    configured: Boolean(privateKey),
    publicKey,
    relays,
    profile: nostrCfg?.profile ?? null,
  };
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function profileToEventContent(profile) {
  return {
    ...(profile.name ? { name: profile.name } : {}),
    ...(profile.displayName ? { display_name: profile.displayName } : {}),
    ...(profile.about ? { about: profile.about } : {}),
    ...(profile.picture ? { picture: profile.picture } : {}),
    ...(profile.banner ? { banner: profile.banner } : {}),
    ...(profile.website ? { website: profile.website } : {}),
    ...(profile.nip05 ? { nip05: profile.nip05 } : {}),
    ...(profile.lud16 ? { lud16: profile.lud16 } : {}),
  };
}

async function importProfileFromRelays({ pubkey, relays, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const pool = new SimplePool();
  const events = [];
  try {
    await Promise.race([
      new Promise((resolve) => {
        let completed = 0;
        for (const relay of relays) {
          const sub = pool.subscribeMany([relay], [{ kinds: [0], authors: [pubkey], limit: 1 }], {
            onevent(event) { events.push({ event, relay }); },
            oneose() { completed += 1; if (completed >= relays.length) resolve(); },
            onclose() { completed += 1; if (completed >= relays.length) resolve(); },
          });
          setTimeout(() => sub.close(), timeoutMs);
        }
      }),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    if (!events.length) return { ok: false, error: 'No profile found on any relay', relaysQueried: relays };
    let best = events[0];
    for (const item of events) if ((item.event?.created_at ?? 0) > (best.event?.created_at ?? 0)) best = item;
    if (!verifyEvent(best.event)) return { ok: false, error: 'Profile event has invalid signature', relaysQueried: relays, sourceRelay: best.relay };
    let content;
    try { content = JSON.parse(best.event.content); } catch { return { ok: false, error: 'Profile event has invalid JSON content', relaysQueried: relays, sourceRelay: best.relay }; }
    return {
      ok: true,
      profile: contentToProfile(content),
      event: { id: best.event.id, pubkey: best.event.pubkey, created_at: best.event.created_at },
      relaysQueried: relays,
      sourceRelay: best.relay,
    };
  } finally {
    try { pool.close(relays); } catch {}
  }
}

async function publishProfile(accountId, profile) {
  const runtime = getNostrRuntime();
  const bus = runtime?.channels?.getActiveBus?.('nostr', accountId) ?? runtime?.channels?.getActiveBus?.(accountId);
  if (bus?.publishProfile) return bus.publishProfile(profile);
  throw new Error(`Nostr bus not running for account ${accountId}`);
}

async function getProfileState(accountId) {
  const runtime = getNostrRuntime();
  const bus = runtime?.channels?.getActiveBus?.('nostr', accountId) ?? runtime?.channels?.getActiveBus?.(accountId);
  if (bus?.getProfileState) return bus.getProfileState();
  return null;
}

export function createNostrProfileHttpHandler(ctx) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (!url.pathname.startsWith('/api/channels/nostr/')) return false;
    const match = url.pathname.match(/^\/api\/channels\/nostr\/([^/]+)\/profile(\/import)?$/);
    if (!match) return false;
    const accountId = match[1] ?? DEFAULT_ACCOUNT_ID;
    const isImport = Boolean(match[2]);
    try {
      if (req.method === 'GET' && !isImport) {
        const configProfile = ctx.getConfigProfile(accountId);
        const publishState = await getProfileState(accountId);
        sendJson(res, 200, { ok: true, profile: configProfile ?? null, publishState: publishState ?? null });
        return true;
      }
      if (req.method === 'PUT' && !isImport) {
        const body = await readJsonBody(req);
        const parsed = NostrProfileSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(res, 400, { ok: false, error: 'Validation failed', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
          return true;
        }
        const mergedProfile = { ...(ctx.getConfigProfile(accountId) ?? {}), ...parsed.data };
        const result = await publishProfile(accountId, profileToEventContent(mergedProfile));
        await ctx.updateConfigProfile(accountId, mergedProfile);
        sendJson(res, 200, {
          ok: true,
          eventId: result?.eventId ?? null,
          createdAt: result?.createdAt ?? null,
          successes: result?.successes ?? [],
          failures: result?.failures ?? [],
          persisted: true,
        });
        return true;
      }
      if (req.method === 'POST' && isImport) {
        const accountInfo = ctx.getAccountInfo(accountId);
        if (!accountInfo?.pubkey) {
          sendJson(res, 404, { ok: false, error: `Account not found: ${accountId}` });
          return true;
        }
        let autoMerge = false;
        try {
          const body = await readJsonBody(req);
          autoMerge = body?.autoMerge === true;
        } catch {}
        const result = await importProfileFromRelays({ pubkey: accountInfo.pubkey, relays: accountInfo.relays ?? DEFAULT_RELAYS, timeoutMs: 10000 });
        if (!result.ok) {
          sendJson(res, 200, { ok: false, error: result.error, relaysQueried: result.relaysQueried });
          return true;
        }
        if (autoMerge && result.profile) {
          const merged = { ...(ctx.getConfigProfile(accountId) ?? {}), ...result.profile };
          await ctx.updateConfigProfile(accountId, merged);
          sendJson(res, 200, { ok: true, imported: result.profile, merged, saved: true, event: result.event, sourceRelay: result.sourceRelay, relaysQueried: result.relaysQueried });
          return true;
        }
        sendJson(res, 200, { ok: true, imported: result.profile, saved: false, event: result.event, sourceRelay: result.sourceRelay, relaysQueried: result.relaysQueried });
        return true;
      }
      sendJson(res, 405, { ok: false, error: 'Method not allowed' });
      return true;
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
      return true;
    }
  };
}
