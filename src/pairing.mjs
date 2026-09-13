import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import {
  WIRE_VERSION, LIMITS, CAPABILITIES, hexToken, requireThat, exactKeys,
  invitationFragment, validateHello, proof, verifyProof, transcript, PROJECT_WIRE_VERSION, AUTHORING_WIRE_VERSION, BUILD_WIRE_VERSION, projectReadRequested
} from '@web64/mcp-contract';
import { validLocalRequest, Budget } from './security.mjs';
import { validateBrowserCapabilities } from '@web64/mcp-contract/browser-capabilities';
import { validateProjectReadRequest, validateProjectReadReply } from '@web64/mcp-contract/project-read';
import { validateProjectCommandRequest, validateProjectCommandReply, projectCommandScope } from '@web64/mcp-contract/project-command';

export async function createPairing({ ideUrl, clients, clock = Date.now }) {
  const origin = new URL(ideUrl).origin;
  const instance = hexToken();
  const states = new Map(clients.map(client => [client.id, { client, validationEpoch: 0, socket: null, invitation: null, grant: null, pending: new Map(), budget: new Budget() }]));
  const server = createServer((req, res) => { res.writeHead(404); res.end(); });
  server.maxConnections = LIMITS.sockets;
  server.requestTimeout = LIMITS.handshakeMs;
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.envelope, perMessageDeflate: false });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const stateFor = id => {
    const state = states.get(id);
    requireThat(state && state.client.expiresAt > clock(), 'unauthorized');
    return state;
  };
  function disconnect(state) {
    state.validationEpoch++;
    state.invitation = null; state.grant = null; state.responseState = 'unavailable';
    const socket = state.socket; state.socket = null;
    socket?.close(1000, 'Disconnected');
    for (const entry of [...state.pending.values()]) entry.fail('session_unavailable');
  }
  function status(id) {
    const state = stateFor(id);
    if (state.grant && state.grant.expiresAt <= clock()) disconnect(state);
    return { state: state.grant ? 'connected' : 'unpaired', clientId: id,
      sessionId: state.grant?.sessionId ?? null, scopes: state.grant?.scopes || [],
      responseState: state.grant ? state.responseState : 'unavailable',
      validationEpoch: state.validationEpoch, capabilities: CAPABILITIES };
  }
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/session' || !validLocalRequest(req, port, origin, true) || wss.clients.size >= LIMITS.sockets) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      let state, invitation, hello, challenge, wantsRead = false, requestedScopes = [], phase = 'hello';
      let chain = Promise.resolve();
      let timeout = setTimeout(() => ws.close(1008, 'Handshake expired'), LIMITS.handshakeMs);
      const fail = () => { clearTimeout(timeout); ws.close(1008, 'Pairing rejected'); };
      ws.on('error', fail);
      ws.on('close', () => {
        clearTimeout(timeout);
        if (state?.socket === ws) disconnect(state);
      });
      ws.on('message', (raw, binary) => {
        // Serialize asynchronous proofs; a second message cannot race a state transition.
        chain = chain.then(async () => {
          requireThat(!binary && ws.readyState === ws.OPEN);
          const message = JSON.parse(raw.toString('utf8'));
          if (phase === 'hello') {
            validateHello(message);
            state = [...states.values()].find(item => item.invitation?.id === message.id);
            requireThat(state && state.client.expiresAt > clock(), 'invitation_invalid');
            invitation = state.invitation;
            requireThat(message.wire === invitation.wire, 'contract_incompatible');
            wantsRead = projectReadRequested(invitation); requestedScopes = invitation.scopes || [];
            requireThat(invitation.expiresAt > clock() && message.instance === instance, 'invitation_invalid');
            state.invitation = null; // Claim once, before the first asynchronous operation.
            state.socket = ws; hello = message;
            challenge = { type: 'challenge', serverNonce: hexToken() };
            phase = 'proof';
            challenge.proof = await proof(invitation.secret, transcript(invitation, hello, challenge, 'bridge'));
            requireThat(state.socket === ws && ws.readyState === ws.OPEN);
            ws.send(JSON.stringify(challenge));
          } else if (phase === 'proof') {
            exactKeys(message, ['type', 'proof']);
            requireThat(message.type === 'proof' && invitation.expiresAt > clock());
            requireThat(await verifyProof(invitation.secret, transcript(invitation, hello, challenge, 'browser'), message.proof));
            requireThat(state.socket === ws && state.client.expiresAt > clock() && ws.readyState === ws.OPEN);
            clearTimeout(timeout);
            timeout = setTimeout(() => ws.close(1008, 'Consent expired'), Math.max(1, invitation.expiresAt - clock()));
            phase = 'consent'; invitation = null;
            ws.send(JSON.stringify({ type: 'verified' }));
          } else if (phase === 'consent') {
            exactKeys(message, ['type', ...(wantsRead ? ['scopes'] : [])]);
            requireThat(message.type === 'consent' && state.socket === ws && state.client.expiresAt > clock());
            if (wantsRead) requireThat(JSON.stringify(message.scopes) === JSON.stringify(requestedScopes), 'scope_denied');
            clearTimeout(timeout); phase = 'connected';
            state.responseState = 'untested';
            state.grant = { wire: hello.wire, sessionId: hello.sessionId,
              scopes: requestedScopes, expiresAt: Math.min(clock() + LIMITS.grantMs, state.client.expiresAt) };
            ws.send(JSON.stringify({ type: 'ready', wire: hello.wire, sessionId: hello.sessionId,
              expiresAt: state.grant.expiresAt, ...(wantsRead ? { scopes: state.grant.scopes } : {}) }));
          } else {
            const release = state.budget.take();
            try {
              requireThat(state.socket === ws && state.grant?.expiresAt > clock());
              exactKeys(message, ['type', 'requestId', 'sessionId', 'result']);
              requireThat(message.type === 'result' && message.sessionId === state.grant.sessionId);
              const pending = state.pending.get(message.requestId);
              // Late responses to cancelled requests carry no authority.
              if (!pending) return;
              pending.validate(message.result);
              if (!pending.projectRead && message.result.projectAccess === 'read')
                requireThat(state.grant.scopes.includes('project:read'), 'scope_denied');
              if (message.result.projectAccess === 'write') requireThat(state.grant.scopes.includes('project:write'), 'scope_denied');
              if (message.result.builds) requireThat(state.grant.scopes.includes('build'), 'scope_denied');
              if (pending.projectRead && message.result.ok)
                requireThat(message.result.value.workspaceToken.sessionId === state.grant.sessionId, 'invalid_project_reply');
              pending.resolve(message.result);
            } finally { release(); }
          }
        }).catch(fail);
      });
    });
  });
  const expiry = setInterval(() => {
    for (const state of states.values()) {
      if (state.client.expiresAt <= clock() || (state.grant && state.grant.expiresAt <= clock())) disconnect(state);
      if (state.invitation?.expiresAt <= clock()) state.invitation = null;
    }
  }, 1000);
  expiry.unref();
  async function request(id, method, params, signal) {
    const state = stateFor(id); status(id);
    requireThat(state.grant && state.socket?.readyState === 1, 'session_unavailable');
    if (method === 'project.read') {
      requireThat(state.grant.scopes.includes('project:read'), 'scope_denied');
      validateProjectReadRequest(params);
    }
    if (method === 'project.command') {
      validateProjectCommandRequest(params);
      requireThat(state.grant.scopes.includes(projectCommandScope(params.action, params.input)), 'scope_denied');
    }
    requireThat(!signal?.aborted, 'request_cancelled');
    requireThat(state.pending.size < LIMITS.requests, 'busy');
    const requestId = hexToken(), socket = state.socket;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); state.pending.delete(requestId); signal?.removeEventListener('abort', abort); };
      const fail = code => { cleanup(); if (code === 'session_unresponsive') state.responseState = 'unresponsive';
        reject(Object.assign(new Error(code), { code })); };
      const abort = () => fail('request_cancelled');
      const timer = setTimeout(() => fail('session_unresponsive'), LIMITS.requestMs);
      state.pending.set(requestId, { fail, projectRead: method === 'project.read',
        validate: method === 'project.read' ? validateProjectReadReply : method === 'project.command' ? validateProjectCommandReply : validateBrowserCapabilities,
        resolve: value => { cleanup(); state.responseState = 'responsive'; resolve(value); } });
      signal?.addEventListener('abort', abort, { once: true });
      socket.send(JSON.stringify({ type: 'request', wire: state.grant.wire, requestId,
        sessionId: state.grant.sessionId, method, ...(params ? { params } : {}) }));
    });
  }
  return {
    port, instance, status,
    begin(id, scope = 'capabilities') {
      requireThat(['capabilities', 'project:read', 'project:write', 'build', 'project:write+build'].includes(scope), 'scope_denied');
      const state = stateFor(id); disconnect(state);
      const builds = ['build', 'project:write+build'].includes(scope), writes = ['project:write', 'project:write+build'].includes(scope);
      const invitation = { wire: builds ? BUILD_WIRE_VERSION : writes ? AUTHORING_WIRE_VERSION : scope === 'project:read' ? PROJECT_WIRE_VERSION : WIRE_VERSION,
        ...(scope !== 'capabilities' ? { scopes: ['project:read', ...(writes ? ['project:write'] : []), ...(builds ? ['build'] : [])] } : {}), id: hexToken(), instance, secret: hexToken(), port,
        expiresAt: Math.min(clock() + LIMITS.invitationMs, state.client.expiresAt), origin, clientLabel: state.client.label };
      state.invitation = invitation;
      return { url: new URL(ideUrl).href + invitationFragment(invitation), expiresAt: invitation.expiresAt,
        authority: builds ? `Current working copy read and builds${writes ? ', editing and explicit local save/export' : '; no editing or saving'}. Requires new browser approval. No Cloud or execution.`
          : scope === 'project:write' ? 'Current working copy read/edit and explicit local save/export; requires new browser approval. No Cloud, builds or execution.' : scope === 'project:read'
          ? 'Current working copy read only, including unsaved drafts; explicitly open invitation and approve project:read in browser.'
          : 'Capability check only; explicitly open invitation and consent in browser.' };
    },
    disconnect(id) { disconnect(stateFor(id)); return status(id); },
    capabilities: (id, signal) => request(id, 'capabilities', null, signal),
    read: (id, params, signal) => request(id, 'project.read', params, signal),
    command: (id, params, signal) => request(id, 'project.command', params, signal),
    async close() {
      clearInterval(expiry);
      for (const state of states.values()) disconnect(state);
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
