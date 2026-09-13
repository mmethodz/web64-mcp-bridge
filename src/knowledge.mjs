import { createHash } from 'node:crypto';
import { KNOWLEDGE_LIMITS as LIMITS, knowledgeAssert as check, validateKnowledgeCatalog,
  validateKnowledgeManifest, searchKnowledge, readKnowledgeText, parseKnowledgeUri } from '@web64/mcp-contract/knowledge';
import { Budget } from './security.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const hash = /^[a-f0-9]{64}$/u;
const hosts = ['https://web64.nofs.ai', 'https://web64-react-p6twac9nn-mika-jussilas-projects.vercel.app',
  'https://web64-react-nbo02ig2k-mika-jussilas-projects.vercel.app'];

// Data adapter only: no compiler, asset normalizer, repository or project mirror.
export function createKnowledgeReader({ ideUrl, allowLocal = false, fetchImpl = fetch, cache = null } = {}) {
  const ide = new URL(ideUrl);
  check(hosts.includes(ide.origin) || (allowLocal && ['127.0.0.1', 'localhost'].includes(ide.hostname)
    && ['https:', 'http:'].includes(ide.protocol)), 'knowledge_origin_not_allowed');
  check(!ide.username && !ide.password && !ide.search && !ide.hash && ['/ide', '/ide/'].includes(ide.pathname));
  const base = new URL('/docs/mcp/', ide.origin);
  const catalogs = new Map(), blobs = new Map(), budget = new Budget();
  const sessions = new WeakMap();
  const stamp = state => JSON.stringify([state.state, state.sessionId, state.validationEpoch || 0]);
  let blobBytes = 0;
  async function download(path, maximum, signal) {
    const combined = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
    let response, reader;
    try {
      combined.throwIfAborted();
      response = await fetchImpl(new URL(path, base), { signal: combined, redirect: 'error', credentials: 'omit',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
      check(response.ok && !response.redirected && response.body, 'knowledge_unavailable');
      check(/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') || ''), 'invalid_knowledge_response');
      const length = response.headers.get('content-length');
      check(length === null || (/^\d+$/u.test(length) && Number(length) <= maximum), 'knowledge_too_large');
      reader = response.body.getReader();
      const chunks = []; let bytes = 0;
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        combined.throwIfAborted(); bytes += value.byteLength;
        check(bytes <= maximum, 'knowledge_too_large'); chunks.push(value);
      }
      return Buffer.concat(chunks, bytes);
    } catch (error) {
      if (signal?.aborted) throw fail('request_cancelled');
      if (combined.aborted) throw fail('knowledge_timeout');
      if (error.code) throw error;
      throw fail('knowledge_unavailable');
    } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
  }
  function parse(bytes) {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw fail('invalid_knowledge_response'); }
  }
  async function verifiedBytes(kind, key, path, maximum, verify, signal) {
    const cached = await cache?.get(kind, key, maximum);
    if (cached) {
      try { verify(cached); return cached; } catch { /* Untrusted/corrupt cache is a miss, never authority. */ }
    }
    const bytes = await download(path, maximum, signal);
    verify(bytes);
    await cache?.put(kind, key, bytes);
    return bytes;
  }
  async function catalogFor({ manifest, signal }) {
    const release = manifest.release;
    check(hash.test(release));
    let cached = catalogs.get(release);
    if (!cached) {
      const verify = bytes => {
        check(bytes.length === manifest.catalogBytes && sha(bytes) === manifest.catalogSha256, 'knowledge_hash_mismatch');
        const catalog = validateKnowledgeCatalog(parse(bytes));
        const { release: embedded, ...core } = catalog;
        check(embedded === release && sha(JSON.stringify(core)) === release, 'knowledge_hash_mismatch');
      };
      const bytes = await verifiedBytes('catalog', release, `releases/${release}/catalog.json`, manifest.catalogBytes, verify, signal);
      const catalog = validateKnowledgeCatalog(parse(bytes));
      cached = { catalog, digest: sha(bytes), bytes: bytes.length };
      // Globally bounded across all clients. Entries carry no private context.
      if (catalogs.size >= 2) catalogs.delete(catalogs.keys().next().value);
      catalogs.set(release, cached);
    }
    check(cached.digest === manifest.catalogSha256 && cached.bytes === manifest.catalogBytes
      && cached.catalog.resources.length === manifest.resourceCount && cached.catalog.web64Version === manifest.web64Version
      && cached.catalog.sdkVersion === manifest.sdkVersion, 'knowledge_hash_mismatch');
    return cached.catalog;
  }
  async function context(pairing, clientId, scope, requestedRelease, signal) {
    check(scope === 'auto' || scope === 'public');
    const state = pairing.status(clientId); // Validates even public callers' credential lifetime.
    const currentStamp = stamp(state);
    let clients = sessions.get(pairing);
    if (!clients) { clients = new Map(); sessions.set(pairing, clients); }
    let session = clients.get(clientId);
    if (!session || session.stamp !== currentStamp) {
      check(clients.has(clientId) || clients.size < 8, 'busy');
      session = { stamp: currentStamp, browser: null, latest: null, releases: new Map(), pending: false };
      clients.set(clientId, session);
    }
    const connected = scope === 'auto' && state.state === 'connected';
    let manifest = connected ? session.browser : requestedRelease ? session.releases.get(requestedRelease) : session.latest;
    if (!manifest) {
      // Single validation in flight for a logical client session. Do not let one
      // request's cancellation abort an unrelated caller's shared network work.
      check(!session.pending, 'busy'); session.pending = true;
      try {
        if (connected) {
          const echo = await pairing.capabilities(clientId, signal);
          check(echo.knowledge, 'connected_knowledge_unavailable');
          manifest = validateKnowledgeManifest(echo.knowledge);
        } else {
          check(!requestedRelease || hash.test(requestedRelease));
          const path = requestedRelease ? `releases/${requestedRelease}/manifest.json` : 'manifest.json';
          manifest = validateKnowledgeManifest(parse(await download(path, 4096, signal)));
          check(!requestedRelease || manifest.release === requestedRelease, 'knowledge_release_mismatch');
        }
        check(!signal?.aborted, 'request_cancelled');
        check(stamp(pairing.status(clientId)) === currentStamp, 'session_unavailable');
        if (connected) session.browser = manifest;
        else {
          if (!requestedRelease) session.latest = manifest;
          if (session.releases.size >= 2) session.releases.delete(session.releases.keys().next().value);
          session.releases.set(manifest.release, manifest);
        }
      } finally { session.pending = false; }
    }
    check(!requestedRelease || requestedRelease === manifest.release, 'knowledge_release_mismatch');
    const catalog = await catalogFor({ manifest, signal });
    check(stamp(pairing.status(clientId)) === currentStamp, 'session_unavailable');
    return { catalog, stamp: currentStamp, binding: { authority: connected ? 'connected-browser' : 'public-release',
      connectedReleaseVerified: connected, origin: ide.origin, validation: 'per-logical-session' } };
  }
  async function run(pairing, clientId, options, signal, operation) {
    const release = budget.take();
    try {
      check(!signal?.aborted, 'request_cancelled');
      const ctx = await context(pairing, clientId, options.scope || 'auto', options.release, signal);
      const result = await operation(ctx.catalog);
      check(!signal?.aborted, 'request_cancelled');
      const current = pairing.status(clientId); // Expired/revoked principals cannot finish a request.
      check(stamp(current) === ctx.stamp, 'session_unavailable');
      return { ...result, binding: ctx.binding };
    } finally { release(); }
  }
  return {
    describe(pairing, clientId, options = {}, signal) {
      return run(pairing, clientId, options, signal, catalog => ({ release: catalog.release,
        web64Version: catalog.web64Version, sdkVersion: catalog.sdkVersion, resourceCount: catalog.resources.length,
        kinds: [...new Set(catalog.resources.map(row => row.kind))],
        searchTool: 'web64_knowledge_search', readTool: 'web64_knowledge_read' }));
    },
    search(pairing, clientId, options, signal) {
      return run(pairing, clientId, options, signal, catalog => searchKnowledge(catalog, options));
    },
    async read(pairing, clientId, options, signal) {
      const { release, id } = parseKnowledgeUri(options.uri);
      return run(pairing, clientId, { ...options, release }, signal, async catalog => {
        const row = catalog.resources.find(item => item.id === id); check(row, 'knowledge_resource_not_found');
        let content = blobs.get(row.sha256)?.text;
        if (content === undefined) {
          const verify = bytes => {
            check(bytes.length === row.bytes && sha(bytes) === row.sha256, 'knowledge_hash_mismatch');
            const blob = parse(bytes);
            check(blob && Object.keys(blob).length === 1 && typeof blob.text === 'string'
              && sha(blob.text) === row.source.contentSha256, 'invalid_knowledge_response');
          };
          const bytes = await verifiedBytes('blob', row.sha256, `releases/${release}/blobs/${row.sha256}.json`, row.bytes, verify, signal);
          const blob = parse(bytes);
          content = blob.text;
          while (blobBytes + bytes.length > 16 * 1024 * 1024 && blobs.size) {
            const key = blobs.keys().next().value; blobBytes -= blobs.get(key).bytes; blobs.delete(key);
          }
          if (!blobs.has(row.sha256)) { blobs.set(row.sha256, { text: content, bytes: bytes.length }); blobBytes += bytes.length; }
        }
        return readKnowledgeText(catalog, row, content, options);
      });
    }
  };
}
