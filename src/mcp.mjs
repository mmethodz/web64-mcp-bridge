import { createServer } from 'node:http';
import { McpServer, ResourceTemplate, createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { CAPABILITIES, MCP_VERSIONS, LIMITS, requireThat } from '@web64/mcp-contract';
import { authenticate, validLocalRequest, readBody, Budget } from './security.mjs';
import { PROJECT_READ_ERRORS } from '@web64/mcp-contract/project-read';
import { PROJECT_COMMAND_ERRORS } from '@web64/mcp-contract/project-command';
import { projectReadLinks, projectResourceRequest } from './project-resources.mjs';
import { BRIDGE_VERSION } from './version.mjs';

const output = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const knownErrors = new Set([...PROJECT_READ_ERRORS, ...PROJECT_COMMAND_ERRORS, 'session_unavailable', 'session_unresponsive', 'unauthorized', 'request_cancelled', 'busy', 'rate_limited',
  'invalid_knowledge_request', 'connected_knowledge_unavailable', 'knowledge_release_mismatch', 'knowledge_hash_mismatch', 'knowledge_incompatible', 'knowledge_snapshot_missing',
  'knowledge_unavailable', 'knowledge_resource_not_found', 'knowledge_timeout', 'knowledge_too_large', 'invalid_knowledge_response']);
export function serverFactory(pairing, clientId, knowledge) {
  return () => {
    const server = new McpServer({ name: 'web64-mcp-bridge', version: BRIDGE_VERSION },
      { supportedProtocolVersions: [...MCP_VERSIONS] });
    server.registerTool('web64_connection', {
      description: 'Request an explicit browser invitation, inspect your own connection, or revoke it. Default is capability-only. project:read requests read-only access; project:write adds editing/local save. build adds builds to read access WITHOUT editing/saving; project:write+build explicitly requests both. Every invitation requires NEW human consent. Never approves its own grant. No Cloud or emulator control.',
      inputSchema: z.object({ action: z.enum(['status', 'begin_pairing', 'disconnect']),
        scope: z.enum(['capabilities', 'project:read', 'project:write', 'build', 'project:write+build']).optional() }).strict()
    }, async ({ action, scope }) => {
      try {
        requireThat(scope === undefined || action === 'begin_pairing', 'invalid_arguments');
        const value = action === 'begin_pairing' ? pairing.begin(clientId, scope)
          : action === 'disconnect' ? pairing.disconnect(clientId) : pairing.status(clientId);
        return output({ ok: true, ...value });
      } catch (error) {
        return { ...output({ ok: false, error: { code: knownErrors.has(error.code) ? error.code : 'request_failed' } }), isError: true };
      }
    });
    server.registerResource('capabilities', 'web64://capabilities', { mimeType: 'application/json' },
      async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(CAPABILITIES) }] }));
    server.registerResource('connection', 'web64://connection', { mimeType: 'application/json' },
      async (uri, ctx) => {
        const state = pairing.status(clientId);
        const echo = state.state === 'connected' ? await pairing.capabilities(clientId, ctx.mcpReq.signal) : null;
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ ...state, browserEcho: echo }) }] };
      });
    const projectRead = async (params, signal) => projectReadLinks(await pairing.read(clientId, params, signal));
    server.registerTool('web64_project_read', {
      description: 'Read only the browser working copy explicitly granted to this client. No Save required. Manifest returns snapshot identity and resource URIs. File record pages contain native Web64 serialization (including base64 bytes/asset metadata); source mode returns text. Continue with the returned snapshotId and nextOffset for consistent pagination. Old snapshots are marked current:false. Search is literal, never regex. No filesystem paths or other client/tab selection.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ action: z.enum(['manifest', 'file', 'configuration', 'search']),
        input: z.object({ snapshotId: z.string().min(1).max(128).optional(),
          expected: z.object({ sessionId: z.string().max(128), epoch: z.string().max(128), generation: z.number().int().nonnegative() }).strict().optional(),
          offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(65536).optional(),
          path: z.string().min(1).max(4096).optional(), view: z.enum(['project', 'contextual-sdk']).optional(),
          representation: z.enum(['record', 'source']).optional(),
          query: z.string().min(1).max(256).optional() }).strict().default({}) }).strict()
    }, async (params, ctx) => {
      try { const result = await projectRead(params, ctx.mcpReq.signal); return { ...output(result), ...(!result.ok ? { isError: true } : {}) }; }
      catch (error) { return { ...output({ ok: false, error: { code: knownErrors.has(error.code) ? error.code : 'request_failed' } }), isError: true }; }
    });
    const expected = z.object({ sessionId: z.string().max(128), epoch: z.string().max(128), generation: z.number().int().nonnegative() }).strict();
    const operation = { operationId: z.string().uuid(), expected };
    const nativeObject = z.record(z.string(), z.unknown());
    const command = action => async (input, ctx) => {
      try { const result = await pairing.command(clientId, { action, input }, ctx.mcpReq.signal);
        return { ...output(result), ...(!result.ok ? { isError: true } : {}) }; }
      catch (error) { return { ...output({ ok: false, error: { code: knownErrors.has(error.code) ? error.code : 'request_failed' } }), isError: true }; }
    };
    server.registerTool('web64_project_apply', {
      description: 'Atomically apply one revision-checked native authoring batch. Requires project:write. File records use the published native schemas; generated outputs cannot be written. Build/media replacements must be complete canonical native manifests. Invalid/raced batches change nothing. Same operationId retries return the original outcome. No saving, builds, Cloud or execution.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ ...operation, changes: z.array(z.discriminatedUnion('op', [
        z.object({ op: z.literal('file.create'), record: nativeObject }).strict(),
        z.object({ op: z.literal('file.write'), record: nativeObject }).strict(),
        z.object({ op: z.literal('file.delete'), path: z.string().max(4096) }).strict(),
        z.object({ op: z.literal('project.configure'), origin: z.string().optional(), selectedEntryLabel: z.string().optional(), cConfig: nativeObject.optional() }).strict(),
        z.object({ op: z.literal('build.replace'), build: nativeObject }).strict(),
        z.object({ op: z.literal('media.replace'), media: nativeObject }).strict()
      ])).min(1).max(128) }).strict()
    }, command('apply'));
    server.registerTool('web64_project_create', {
      description: 'Create through an existing native IDE template and exact version. Requires project:write and no unsaved work in the granted tab; no force discard. Returns the new epoch. No automatic save, Cloud or execution.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ ...operation, templateId: z.string().max(64), templateVersion: z.number().int().positive(), options: nativeObject.optional() }).strict()
    }, command('create'));
    server.registerTool('web64_project_save', {
      description: 'Explicit native .web64proj save. export returns a private artifact, persisted:false; read its chunks with web64_transfer. handle writes only an existing already-permitted browser file handle, otherwise user_action_required. Never opens a picker, downloads automatically, calls Cloud, builds or runs. Retry the same operation ID to reconcile, not a new ID.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ ...operation, mode: z.enum(['export', 'handle']) }).strict()
    }, command('save'));
    server.registerTool('web64_operation', {
      description: 'Read your own grant-local operation status, page structured build output as json-text, or cancel a build. Unknown IDs cannot select another session. Cancel requires build permission. Output offsets are UTF-16 character offsets; concatenate returned pages before parsing JSON. A lost submission response is reconciled by retrying the exact operation ID, not submitting a new job.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ operationId: z.string().uuid(), action: z.enum(['status', 'output', 'cancel']).optional(),
        offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(16384).optional() }).strict()
    }, command('operation'));
    server.registerTool('web64_build', {
      description: 'Submit a browser-native build of captured current VFS inputs, including unsaved drafts; Save is NOT required. Requires a separate build grant. kind target selects targetIds; project builds all; disk-set selects diskSetId and builds dependencies before D64 mastering. PRG, packed-data PRG and compile-only test targets; legacy cartridge execution excluded. Returns a job ID promptly. Same operationId/request retries deduplicate. Read status/output with web64_operation and private bytes with web64_transfer. Never saves, mounts, runs, unlocks audio or changes Live.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ ...operation, kind: z.enum(['target', 'project', 'disk-set']),
        targetIds: z.array(z.string().min(1).max(48)).min(1).max(128).optional(), diskSetId: z.string().min(1).max(48).optional(),
        timeoutMs: z.number().int().min(1).max(300000).optional() }).strict()
    }, command('build'));
    server.registerTool('web64_project_open', {
      description: 'Inspect or open a completed staged native .web64proj upload. Browser-native schema/codec validation; no legacy migration, force-discard, file handle, Cloud or emulator action. Apply rejects unsaved current work and races; a replacement rotates the workspace token. Opening is not saving. M4/G4 verified.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ ...operation, mode: z.enum(['inspect', 'apply']), uploadId: z.string().uuid() }).strict()
    }, command('open'));
    server.registerTool('web64_project_import', {
      description: 'Inspect or atomically apply staged input through native browser importers. Requires project:write and an expected working token. Inspect reports missing choices without mutation; with complete choices it validates a detached candidate and lists derived paths. Apply changes the VFS once, never saves, builds, previews or runs. Upload native binary asset RECORD JSON with metadata for native-record, not bare pixels. Source encoding is utf-8; dialectDecision must explicitly keep or enable-kick5 when review is required. M4/G4 verified.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ ...operation, mode: z.enum(['inspect', 'apply']), imports: z.array(z.object({
        uploadId: z.string().uuid(), profile: z.enum(['source', 'opaque-binary', 'native-record', 'native-sid-source',
          'native-trajectory', 'sid-binary', 'raw-graphics', 'charpad', 'spritepad', 'koala', 'png', 'goattracker-song', 'goattracker-instrument']),
        path: z.string().min(1).max(4096).optional(), options: nativeObject.optional(),
        collision: z.enum(['error', 'replace']).optional(), dialectDecision: z.enum(['keep', 'enable-kick5']).optional()
      }).strict()).min(1).max(100) }).strict()
    }, command('import'));
    server.registerTool('web64_transfer', {
      description: 'Read private artifact chunks, or stage input bytes in the paired browser for native import. Uploads require write permission: upload-begin with operationId/byteLength/SHA-256, ordered upload-chunk with offset/base64 bytes (max 49152 decoded), upload-finish verifies hash, upload-abort frees quota. Same begin ID and identical chunk retry are safe. Maximum 16 MiB/file, 32 MiB staged, eight uploads, ten-minute expiry. No host paths, URLs, file picker, Cloud or VFS mutation. Omitting action keeps the M3 artifact-read form.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.union([
        z.object({ action: z.literal('read').optional(), artifactId: z.string().max(128), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(49152).optional() }).strict(),
        z.object({ action: z.literal('upload-begin'), operationId: z.string().uuid(), byteLength: z.number().int().min(0).max(16777216), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
        z.object({ action: z.literal('upload-chunk'), uploadId: z.string().uuid(), offset: z.number().int().nonnegative(), bytes: z.string().min(1).max(65536) }).strict(),
        z.object({ action: z.enum(['upload-finish', 'upload-abort']), uploadId: z.string().uuid() }).strict()
      ])
    }, async ({ action = 'read', ...input }, ctx) => action === 'read' ? command('artifact')(input, ctx)
      : command('upload')({ action: action.slice('upload-'.length), input }, ctx));
    server.registerResource('project-snapshot',
      new ResourceTemplate('web64://sessions/{sessionId}/projects/{projectId}/snapshots/{snapshotId}/{+resource}', { list: undefined }),
      { mimeType: 'application/json', description: 'Private snapshot page, scoped to the paired client. Use web64_project_read for subsequent pages.' },
      async (uri, _vars, ctx) => {
        const result = await projectRead(projectResourceRequest(uri.href), ctx.mcpReq.signal);
        requireThat(result.ok, result.error?.code || 'request_failed');
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(result) }] };
      });
    if (knowledge) {
      const scope = z.enum(['auto', 'public']).default('auto');
      const release = z.string().regex(/^[a-f0-9]{64}$/u).optional();
      const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
      const invoke = method => async (args, ctx) => {
        try { return output(await knowledge[method](pairing, clientId, args, ctx.mcpReq.signal)); }
        catch (error) { return { ...output({ ok: false, error: { code: knownErrors.has(error.code) ? error.code : 'request_failed' } }), isError: true }; }
      };
      server.registerTool('web64_knowledge_search', {
        description: 'Search the latest published Web64 SDK, documentation and native schemas. The current public knowledge hash is validated per session. Browser/hash differences are reported explicitly, not used to select historical authoring versions. Public scope never claims a connected-browser match.',
        annotations, inputSchema: z.object({ query: z.string().min(1).max(256),
          kind: z.enum(['sdk', 'docs', 'schemas', 'templates', 'imports']).optional(),
          offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20).default(10), scope, release }).strict()
      }, invoke('search'));
      server.registerTool('web64_knowledge_read', {
        description: 'Read public knowledge using the current session publication. Old URIs resolve by resource ID with explicit fallback metadata and the actual returned URI/hash. If paginationReset is true, discard earlier pages and restart from this first page. Follow nextOffset in UTF-16 code units.',
        annotations, inputSchema: z.object({ uri: z.string().max(8192), offset: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(24000).default(24000), scope }).strict()
      }, invoke('read'));
      server.registerResource('knowledge', 'web64://knowledge', { mimeType: 'application/json',
        description: 'Available release, source binding and knowledge discovery tools; no project content.' },
      async (uri, ctx) => ({ contents: [{ uri: uri.href, mimeType: 'application/json',
        text: JSON.stringify(await knowledge.describe(pairing, clientId, {}, ctx.mcpReq.signal)) }] }));
      server.registerResource('knowledge-content', new ResourceTemplate('web64://knowledge/{release}/{+id}', { list: undefined }),
        { mimeType: 'application/json', description: 'Bounded first page; use web64_knowledge_read with nextOffset for subsequent pages.' },
        async (uri, _vars, ctx) => ({ contents: [{ uri: uri.href, mimeType: 'application/json',
          text: JSON.stringify(await knowledge.read(pairing, clientId, { uri: uri.href }, ctx.mcpReq.signal)) }] }));
    }
    return server;
  };
}
export function startStdio(pairing, clientId, { stdin = process.stdin, stdout = process.stdout, knowledge } = {}) {
  return serveStdio(serverFactory(pairing, clientId, knowledge), {
    transport: new StdioServerTransport(stdin, stdout, { maxBufferSize: LIMITS.envelope }),
    legacy: 'serve', maxSubscriptions: 0,
    onerror: () => process.stderr.write('[ERROR] MCP protocol request rejected.\n')
  });
}
export async function startHttp(pairing, credentials, { port = 8764, origin, responseMode = 'auto', knowledge } = {}) {
  requireThat(credentials.length > 0, 'http_credentials_required');
  // Each authenticated principal has an independent SDK bus, budget and browser grant.
  const clients = new Map(credentials.map(client => {
    const handler = createMcpHandler(serverFactory(pairing, client.id, knowledge), {
      legacy: 'stateless', responseMode, maxSubscriptions: 0
    });
    return [client.id, { handler, node: toNodeHandler(handler), budget: new Budget() }];
  }));
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reject = (status, code) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: code })); };
    if (req.url !== '/mcp') { reject(404, 'not_found'); return; }
    if (!validLocalRequest(req, server.address().port, origin)) { reject(403, 'forbidden'); return; }
    const principal = authenticate(req.headers.authorization, credentials);
    if (!principal || !clients.has(principal.id)) { reject(401, 'unauthorized'); return; }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); reject(405, 'method_not_allowed'); return; }
    if (!/^application\/json(?:\s*;.*)?$/iu.test(req.headers['content-type'] || '')) { reject(415, 'json_required'); return; }
    if (Number(req.headers['content-length']) > LIMITS.envelope) { reject(413, 'payload_too_large'); return; }
    const client = clients.get(principal.id);
    let release;
    try {
      release = client.budget.take();
      res.once('close', release); res.once('finish', release);
      const body = await readBody(req);
      requireThat(principal.expiresAt > Date.now(), 'unauthorized');
      // Identity is a verified closure, never a caller-selected MCP/session field.
      await client.node(req, res, body);
    } catch (error) {
      release?.();
      if (!res.headersSent && !res.destroyed) reject(error.code === 'rate_limited' ? 429 : error.code === 'unauthorized' ? 401 : 400, 'request_rejected');
      else res.destroy();
    }
  });
  server.maxConnections = LIMITS.sockets;
  server.requestTimeout = LIMITS.handshakeMs;
  server.headersTimeout = LIMITS.handshakeMs;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { port: server.address().port,
    async revokeClient(id) {
      const client = clients.get(id);
      if (!client) return;
      clients.delete(id);
      try { pairing.disconnect(id); } catch { /* Already expired. */ }
      await client.handler.close();
    },
    async close() {
    await Promise.all([...clients.values()].map(client => client.handler.close()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  } };
}
