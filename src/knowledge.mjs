import { createHash } from 'node:crypto';
import { KNOWLEDGE_LIMITS as LIMITS, knowledgeAssert as check, validateKnowledgeCatalog,
  validateKnowledgeManifest, searchKnowledge, readKnowledgeText, parseKnowledgeUri } from '@web64/mcp-contract/knowledge';
import { Budget } from './security.mjs';
import { knowledgeLine, resolveKnowledgeLine } from './knowledge-lines.mjs';

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
      check(![404, 410].includes(response.status), 'knowledge_snapshot_missing');
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
      session = { stamp: currentStamp, echo: null, resolutions: new Map(), pending: false };
      clients.set(clientId, session);
    }
    const connected = scope === 'auto' && state.state === 'connected';
    const key = connected ? 'browser' : 'public';
    let resolution = session.resolutions.get(key);
    if (!resolution) {
      // Single validation in flight for a logical client session. Do not let one
      // request's cancellation abort an unrelated caller's shared network work.
      check(!session.pending, 'busy'); session.pending = true;
      try {
        if (connected && !session.echo) session.echo = await pairing.capabilities(clientId, signal);
        const echo = connected ? session.echo : null;
        const requestedVersion = echo?.web64Version || echo?.knowledge?.web64Version || null;
        let manifest;
        try {
          const index = parse(await download('knowledge-lines.json', 128 * 1024, signal));
          manifest = resolveKnowledgeLine(index, requestedVersion).manifest;
        } catch (error) {
          if (error.code !== 'knowledge_snapshot_missing') throw error;
          // Rolling deployment: an origin without the new index still has a
          // current manifest. Network/integrity failures never use stale cache.
          manifest = validateKnowledgeManifest(parse(await download('manifest.json', 4096, signal)));
        }
        await catalogFor({ manifest, signal });
        const exactHash = Boolean(echo?.knowledge && echo.knowledge.release === manifest.release);
        const line = knowledgeLine(manifest.web64Version);
        resolution = { manifest, binding: { authority: connected ? exactHash ? 'connected-browser' : 'compatible-public-release' : 'public-release',
          connectedReleaseVerified: connected && exactHash, requestedVersion, resolvedKnowledgeLine: line,
          exactMatch: exactHash || Boolean(requestedVersion && knowledgeLine(requestedVersion) === line),
          fallback: Boolean(connected && !exactHash), contentHash: manifest.release,
          knowledgeReleaseIdentity: manifest.release } };
        check(!signal?.aborted, 'request_cancelled');
        check(stamp(pairing.status(clientId)) === currentStamp, 'session_unavailable');
        if (session.resolutions.size >= 3) session.resolutions.delete(session.resolutions.keys().next().value);
        session.resolutions.set(key, resolution);
      } finally { session.pending = false; }
    }
    const catalog = await catalogFor({ manifest: resolution.manifest, signal });
    check(stamp(pairing.status(clientId)) === currentStamp, 'session_unavailable');
    const requestedHashDiffers = Boolean(requestedRelease && requestedRelease !== catalog.release);
    return { catalog, stamp: currentStamp, binding: { ...resolution.binding,
      ...(requestedRelease ? { requestedContentHash: requestedRelease,
        exactMatch: !requestedHashDiffers, fallback: requestedHashDiffers || resolution.binding.fallback } : {}),
      origin: ide.origin, validation: 'per-logical-session', selection: 'latest-published' } };
  }
  async function run(pairing, clientId, options, signal, operation, refreshed = false) {
    const release = budget.take();
    try {
      check(!signal?.aborted, 'request_cancelled');
      const ctx = await context(pairing, clientId, options.scope || 'auto', options.release, signal);
      const result = await operation(ctx.catalog);
      check(!signal?.aborted, 'request_cancelled');
      const current = pairing.status(clientId); // Expired/revoked principals cannot finish a request.
      check(stamp(current) === ctx.stamp, 'session_unavailable');
      return { ...result, binding: ctx.binding };
    } catch (error) {
      if (error.code !== 'knowledge_snapshot_missing' || refreshed) throw error;
      // A deployment may retire this session's previously current corpus.
      // Revalidate current publication once, never serve an offline cached fallback.
      sessions.get(pairing)?.delete(clientId);
      return await run(pairing, clientId, options, signal, operation, true);
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
          const bytes = await verifiedBytes('blob', row.sha256, `releases/${catalog.release}/blobs/${row.sha256}.json`, row.bytes, verify, signal);
          const blob = parse(bytes);
          content = blob.text;
          while (blobBytes + bytes.length > 16 * 1024 * 1024 && blobs.size) {
            const key = blobs.keys().next().value; blobBytes -= blobs.get(key).bytes; blobs.delete(key);
          }
          if (!blobs.has(row.sha256)) { blobs.set(row.sha256, { text: content, bytes: bytes.length }); blobBytes += bytes.length; }
        }
        // Do not concatenate an old snapshot's first page with a new one's tail.
        const reset = release !== catalog.release && (options.offset || 0) > 0;
        return { ...readKnowledgeText(catalog, row, content, reset ? { ...options, offset: 0 } : options),
          ...(reset ? { paginationReset: true, requestedOffset: options.offset } : {}) };
      });
    }
  };
}
