// Python and Node.js report a missing file or package with different words.
// Matching one runtime's error text in a component once told Python users to
// look for Node's MODULE_NOT_FOUND (issue #518). All matching of a server's
// startup error text lives in src/utils/mcp/startupFailureHint.ts, with tests.
const MARKERS = [
  'MODULE_NOT_FOUND',
  'ModuleNotFoundError',
  'No module named',
  'Cannot find module',
  'Cannot find package',
  "can't open file",
];

const markerIn = (text) => MARKERS.find((marker) => text.includes(marker));

const isErrorCodeComparison = (node) => {
  const parent = node.parent;
  if (parent?.type !== 'BinaryExpression' || !['===', '!==', '==', '!='].includes(parent.operator)) return false;
  const other = parent.left === node ? parent.right : parent.left;
  return other.type === 'MemberExpression' && !other.computed && other.property.name === 'code';
};

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Recognise MCP server startup errors only in startupFailureHint.ts' },
    schema: [],
    messages: {
      adhocMatch:
        'Do not match "{{marker}}" here. Call findStartupFailureHint from '
        + "'@/utils/mcp/startupFailureHint' and add any new case, with a real error sample, to its tests.",
    },
  },
  create(context) {
    const check = (node, text) => {
      const marker = typeof text === 'string' ? markerIn(text) : undefined;
      if (marker && !isErrorCodeComparison(node)) context.report({ node, messageId: 'adhocMatch', data: { marker } });
    };
    return {
      Literal: (node) => check(node, node.regex ? node.regex.pattern : node.value),
      TemplateElement: (node) => check(node, node.value.cooked ?? node.value.raw),
    };
  },
};
