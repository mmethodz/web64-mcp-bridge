// Compatibility selection is separate from byte integrity and grant authority.
import { knowledgeAssert as check, validateKnowledgeManifest } from '@web64/mcp-contract/knowledge';
export function knowledgeLine(version) {
  const match = typeof version === 'string' && /^(\d+)\.(\d+)(?:\.|$)/.exec(version);
  return match ? `${Number(match[1])}.${Number(match[2])}` : null;
}
const compare = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  return x[0] - y[0] || x[1] - y[1];
};
export function validateKnowledgeLines(index) {
  check(index?.schema === 'web64.knowledge-lines' && index.version === 1
    && index.lines && typeof index.lines === 'object' && !Array.isArray(index.lines), 'invalid_knowledge_response');
  const lines = Object.keys(index.lines);
  check(lines.length > 0 && lines.length <= 128, 'invalid_knowledge_response');
  for (const line of lines) {
    const manifest = validateKnowledgeManifest(index.lines[line]);
    check(knowledgeLine(manifest.web64Version) === line, 'invalid_knowledge_response');
  }
  check(index.latest === lines.sort(compare).at(-1), 'invalid_knowledge_response');
  check(Array.isArray(index.incompatibleMajors || []) && (index.incompatibleMajors || []).every(pair =>
    Array.isArray(pair) && pair.length === 2 && pair.every(n => Number.isSafeInteger(n) && n >= 0)), 'invalid_knowledge_response');
  return index;
}
export function resolveKnowledgeLine(index, requestedVersion = null) {
  validateKnowledgeLines(index);
  const requested = knowledgeLine(requestedVersion);
  // Web64 is hosted/current. Retained historical pins are not authoring targets.
  const line = index.latest;
  check(!requested || !(index.incompatibleMajors || []).some(([from, to]) =>
    from === Number(line.split('.')[0]) && to === Number(requested.split('.')[0])), 'knowledge_incompatible');
  return { manifest: index.lines[line], requestedVersion, resolvedKnowledgeLine: line,
    exactMatch: Boolean(requested && requested === line), fallback: Boolean(requested && requested !== line) };
}
