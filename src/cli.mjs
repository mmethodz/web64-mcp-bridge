#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { LIMITS, requireThat } from '@web64/mcp-contract';
import { readCredentials } from './security.mjs';
import { createPairing } from './pairing.mjs';
import { startHttp, startStdio } from './mcp.mjs';
import { createKnowledgeReader } from './knowledge.mjs';
import { createPublicKnowledgeCache } from './public-knowledge-cache.mjs';
import { BRIDGE_VERSION } from './version.mjs';

let pairing, transport, stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await transport?.close(); await pairing?.close();
}
try {
  const { values } = parseArgs({ options: {
    transport: { type: 'string', default: 'stdio' }, port: { type: 'string', default: '8764' },
    'ide-url': { type: 'string', default: 'https://web64.nofs.ai/ide/' },
    'allow-local-ide': { type: 'boolean', default: false }, 'no-knowledge-cache': { type: 'boolean', default: false }, help: { type: 'boolean', default: false }
  }, allowPositionals: false });
  if (values.help) {
    process.stderr.write(`web64-mcp-bridge v${BRIDGE_VERSION} [--transport stdio|http] [--port 8764] [--ide-url URL --allow-local-ide] [--no-knowledge-cache]\nHTTP requires WEB64_MCP_HTTP_CREDENTIALS (see README). Explicit browser consent separately grants current-project reads, native editing/local save and builds. No Cloud or emulator execution.\n`);
  } else {
    requireThat(['stdio', 'http'].includes(values.transport), 'invalid_transport');
    const url = new URL(values['ide-url']);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.pathname === '/ide') url.pathname = '/ide/';
    requireThat(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/ide/', 'invalid_ide_url');
    const hosted = ['https://web64.nofs.ai', 'https://web64-react-p6twac9nn-mika-jussilas-projects.vercel.app',
      // GitHub deployment 6411583913, verified M0 commit d35c014. Exact origin only.
      'https://web64-react-nbo02ig2k-mika-jussilas-projects.vercel.app'];
    requireThat(hosted.includes(url.origin) || (values['allow-local-ide'] && local && ['http:', 'https:'].includes(url.protocol)), 'origin_not_allowed');
    const port = Number(values.port);
    requireThat(Number.isInteger(port) && port > 0 && port < 65536, 'invalid_port');
    const clients = values.transport === 'http' ? readCredentials(process.env.WEB64_MCP_HTTP_CREDENTIALS)
      : [{ id: 'stdio', label: 'Local MCP client', expiresAt: Date.now() + LIMITS.grantMs }];
    delete process.env.WEB64_MCP_HTTP_CREDENTIALS;
    pairing = await createPairing({ ideUrl: url.href, clients });
    const cache = values['no-knowledge-cache'] ? null : createPublicKnowledgeCache({ origin: url.origin,
      onUnavailable: () => process.stderr.write('[WARN] Public knowledge disk cache unavailable; continuing without it.\n') });
    const knowledge = createKnowledgeReader({ ideUrl: url.href, allowLocal: values['allow-local-ide'], cache });
    transport = values.transport === 'http'
      ? await startHttp(pairing, clients, { port, origin: url.origin, knowledge }) : startStdio(pairing, 'stdio', { knowledge });
    process.stderr.write(`[INFO] Web64 bridge v${BRIDGE_VERSION} (${values.transport}); knowledge and granted project operations run only on request.\n`);
    if (values.transport === 'stdio') process.stdin.once('end', () => void stop());
    process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
  }
} catch (error) {
  // Error messages from dependencies may embed headers/URLs; report only controlled codes.
  process.stderr.write(`[ERROR] Bridge startup failed (${error.code === 'EADDRINUSE' ? 'port_in_use' : 'invalid_configuration'}). See README.\n`);
  await stop(); process.exitCode = 1;
}
