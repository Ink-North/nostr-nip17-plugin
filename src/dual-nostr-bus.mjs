import {
  SimplePool,
  finalizeEvent,
  getPublicKey,
  nip04,
  nip17,
  nip19,
  kinds,
  verifyEvent,
} from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol'];
const DEFAULT_LOOKBACK_SECONDS = (72 * 60 * 60) + 3600;
const DEFAULT_SUBSCRIPTION_MAX_WAIT_MS = 15000;

function normalizePrivateKeyHex(privateKey) {
  const trimmed = String(privateKey || '').trim();
  if (!trimmed) throw new Error('Missing Nostr private key');
  if (trimmed.startsWith('nsec1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== 'nsec') throw new Error('Invalid nsec');
    const data = decoded.data;
    if (typeof data === 'string') return data.toLowerCase();
    return bytesToHex(data).toLowerCase();
  }
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  throw new Error('Private key must be nsec or 64-char hex');
}

function unique(list) {
  return [...new Set((list || []).filter(Boolean))];
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function isIgnorableGiftWrapError(message) {
  return (
    message.includes('invalid MAC') ||
    message.includes('invalid base64') ||
    message.includes('unknown encryption version') ||
    message.includes('invalid data length')
  );
}

async function publishToAny(pool, relays, event) {
  const publishes = pool.publish(relays, event);
  if (!Array.isArray(publishes) || publishes.length === 0) {
    throw new Error('No publish promises returned');
  }
  await Promise.any(publishes);
}

async function sendNip04Dm(pool, skHex, toPubkey, text, relays) {
  const skBytes = hexToBytes(skHex);
  const pubkey = getPublicKey(skBytes);
  const ciphertext = await nip04.encrypt(skHex, toPubkey, text);
  const event = finalizeEvent({
    kind: kinds.EncryptedDirectMessage,
    created_at: nowSec(),
    tags: [['p', toPubkey]],
    content: ciphertext,
  }, skBytes);
  await publishToAny(pool, relays, event);
  return { mode: 'nip04', eventId: event.id, fromPubkey: pubkey };
}

async function sendNip17Dm(pool, skHex, ourPubkey, toPubkey, text, relays) {
  const skBytes = hexToBytes(skHex);
  const wrappedForRecipient = await nip17.wrapEvent(skBytes, { publicKey: toPubkey }, text);
  const wrappedForSelf = await nip17.wrapEvent(skBytes, { publicKey: ourPubkey }, text);
  await Promise.all([
    publishToAny(pool, relays, wrappedForRecipient),
    publishToAny(pool, relays, wrappedForSelf),
  ]);
  return { mode: 'nip17', eventId: wrappedForRecipient.id, selfEventId: wrappedForSelf.id };
}

export async function startDualNostrBus(options) {
  const {
    privateKey,
    relays = DEFAULT_RELAYS,
    onMessage,
    onError,
    onEose,
    onConnect,
    onDisconnect,
    onDebug,
    authorizeSender,
    nip04Enabled = true,
    nip17Enabled = true,
    outboundMode = 'nip17',
    inboxLookbackSeconds = DEFAULT_LOOKBACK_SECONDS,
    subscriptionMaxWaitMs = DEFAULT_SUBSCRIPTION_MAX_WAIT_MS,
  } = options || {};

  const skHex = normalizePrivateKeyHex(privateKey);
  const skBytes = hexToBytes(skHex);
  const ourPubkey = getPublicKey(skBytes);
  const activeRelays = unique(relays);
  const pool = new SimplePool({
    enablePing: true,
    enableReconnect: true,
    onRelayConnectionSuccess: (url) => onConnect?.(url),
    onRelayConnectionFailure: (url) => onDebug?.(`relay connection failure ${url}`),
  });
  const seen = new Set();

  const reply = async (toPubkey, text, mode = outboundMode) => {
    if (mode === 'nip04') return sendNip04Dm(pool, skHex, toPubkey, text, activeRelays);
    return sendNip17Dm(pool, skHex, ourPubkey, toPubkey, text, activeRelays);
  };

  const subscriptions = [];

  async function handleEvent(event) {
    try {
      if (!event || !verifyEvent(event)) return;
      if (seen.has(event.id)) return;

      if (nip04Enabled && event.kind === kinds.EncryptedDirectMessage) {
        onDebug?.(`saw nip04 event ${event.id} from ${event.pubkey}`);
        const tags = Array.isArray(event.tags) ? event.tags : [];
        if (!tags.some((t) => t?.[0] === 'p' && t?.[1] === ourPubkey)) return;
        const replyFn = async (text, mode = 'nip04') => reply(event.pubkey, text, mode);
        if (authorizeSender) {
          const decision = await authorizeSender({ senderPubkey: event.pubkey, reply: replyFn });
          if (decision !== 'allow') {
            seen.add(event.id);
            return;
          }
        }
        seen.add(event.id);
        const plaintext = await nip04.decrypt(skHex, event.pubkey, event.content);
        await onMessage?.(event.pubkey, plaintext, replyFn, {
          eventId: event.id,
          createdAt: event.created_at,
          mode: 'nip04',
          event,
        });
        return;
      }

      if (nip17Enabled && event.kind === kinds.GiftWrap) {
        onDebug?.(`saw giftwrap ${event.id} from ${event.pubkey}`);
        const rumor = await nip17.unwrapEvent(event, skBytes);
        onDebug?.(`unwrapped giftwrap ${event.id} to rumor kind=${rumor?.kind} pubkey=${rumor?.pubkey || ''}`);
        if (!rumor || rumor.kind !== kinds.PrivateDirectMessage) return;
        const rumorTags = Array.isArray(rumor.tags) ? rumor.tags : [];
        const recipients = rumorTags.filter((t) => t?.[0] === 'p' && t?.[1]).map((t) => t[1]);
        const senderPubkey = rumor.pubkey;
        const includesUs = recipients.includes(ourPubkey);
        const isOurMirror = senderPubkey === ourPubkey;
        if (!includesUs && !isOurMirror) {
          onDebug?.(`ignoring rumor ${event.id}, not addressed to us`);
          return;
        }
        if (isOurMirror) {
          onDebug?.(`ignoring self mirror rumor ${event.id}`);
          return;
        }
        const replyFn = async (text, mode = 'nip17') => reply(senderPubkey, text, mode);
        if (authorizeSender) {
          const decision = await authorizeSender({ senderPubkey, reply: replyFn });
          if (decision !== 'allow') {
            seen.add(event.id);
            return;
          }
        }
        seen.add(event.id);
        await onMessage?.(senderPubkey, rumor.content || '', replyFn, {
          eventId: event.id,
          createdAt: rumor.created_at || event.created_at,
          mode: 'nip17',
          event,
          unwrapped: rumor,
        });
      }
    } catch (err) {
      const message = err?.message ?? String(err);
      if (event?.kind === kinds.GiftWrap && isIgnorableGiftWrapError(message)) return;
      onError?.(err, 'dual bus event');
    }
  }

  const since = nowSec() - inboxLookbackSeconds;

  if (nip04Enabled) {
    const sub04 = pool.subscribeMany(activeRelays, {
      kinds: [kinds.EncryptedDirectMessage],
      '#p': [ourPubkey],
      since,
    }, {
      maxWait: subscriptionMaxWaitMs,
      onevent: handleEvent,
      oneose: () => onEose?.(activeRelays.join(', ')),
      onclose: (reason) => {
        const reasonText = Array.isArray(reason) ? reason.join(', ') : String(reason || 'closed');
        onDebug?.(`nip04 subscription closed: ${reasonText}`);
      },
    });
    subscriptions.push(sub04);
  }

  if (nip17Enabled) {
    const requests = [];
    for (const relay of activeRelays) {
      requests.push({ url: relay, filter: { kinds: [kinds.GiftWrap], '#p': [ourPubkey], since } });
    }
    const sub17 = pool.subscribeMap(requests, {
      maxWait: subscriptionMaxWaitMs,
      onevent: handleEvent,
      oneose: () => onEose?.(activeRelays.join(', ')),
      onclose: (reasons) => {
        const reasonText = Array.isArray(reasons) ? reasons.join(', ') : String(reasons || 'closed');
        onDebug?.(`nip17 subscription closed: ${reasonText}`);
      },
    });
    subscriptions.push(sub17);
  }

  return {
    pubkey: ourPubkey,
    close() {
      for (const relay of activeRelays) onDisconnect?.(relay);
      for (const sub of subscriptions) {
        try { sub.close?.('closed'); } catch {}
      }
      try { pool.close(activeRelays); } catch {}
    },
    async send({ toPubkey, text, mode = outboundMode }) {
      return reply(toPubkey, text, mode);
    },
    async sendDm(toPubkey, text) {
      return reply(toPubkey, text, outboundMode);
    },
    getMetrics() {
      return {};
    },
  };
}
