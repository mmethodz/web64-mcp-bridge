import { requireThat } from '@web64/mcp-contract';

export function projectReadLinks(reply) {
  if (!reply.ok) return reply;
  const value = reply.value;
  const base = `web64://sessions/${encodeURIComponent(value.workspaceToken.sessionId)}/projects/${encodeURIComponent(value.projectId)}/snapshots/${encodeURIComponent(value.snapshotId)}`;
  return { ...reply, value: { ...value, resources: { manifest: `${base}/manifest`, configuration: `${base}/configuration` },
    ...(value.contextualSdk ? { contextualSdk: value.contextualSdk.map(item => ({ ...item, uri: `${base}/sdk/${encodeURIComponent(item.path)}` })) } : {}),
    ...(value.items ? { items: value.items.map(item => ({ ...item, uri: `${base}/files/${encodeURIComponent(item.path)}` })) } : {}) } };
}
export function projectResourceRequest(uri) {
  requireThat(typeof uri === 'string' && uri.length <= 16384, 'invalid_arguments');
  const match = /^web64:\/\/sessions\/([^/]+)\/projects\/([^/]+)\/snapshots\/([^/]+)\/(manifest|configuration|(?:files|sdk)\/[^/?#]+)$/u.exec(uri);
  requireThat(match, 'invalid_arguments');
  let sessionId, projectId, snapshotId, path;
  try {
    [sessionId, projectId, snapshotId] = match.slice(1, 4).map(decodeURIComponent);
    if (match[4].includes('/')) path = decodeURIComponent(match[4].slice(match[4].indexOf('/') + 1));
  } catch { requireThat(false, 'invalid_arguments'); }
  return { action: path === undefined ? match[4] : 'file', input: { sessionId, projectId, snapshotId,
    ...(path === undefined ? {} : { path, view: match[4].startsWith('sdk/') ? 'contextual-sdk' : 'project' }) } };
}
