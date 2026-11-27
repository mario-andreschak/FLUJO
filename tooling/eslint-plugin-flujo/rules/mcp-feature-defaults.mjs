// MCP Apps, Skills over MCP and elicitation are on unless the user turned them
// off for a server (#1448). Reading a switch as `config.enableMcpApps === true`
// quietly turns an unset switch into "off" again, which is how these features
// stayed opt-in. One module decides: src/shared/utils/mcpClientFeatures.ts.
const HELPER = 'src/shared/utils/mcpClientFeatures.ts';
const SWITCHES = new Set(['enableMcpApps', 'enableMcpSkills']);
const OPERATORS = new Set(['===', '!==', '==', '!=']);

function repoPath(filename) {
  const normalized = filename.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/src/');
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function unwrap(node) {
  return node.type === 'ChainExpression' ? node.expression : node;
}

function propertyName(node) {
  const member = unwrap(node);
  if (member.type !== 'MemberExpression' || member.computed || member.property.type !== 'Identifier') return undefined;
  return member.property.name;
}

/** `x.enableMcpApps`, `x.enableMcpSkills` or `x.elicitation.enabled`. */
function switchName(node) {
  const name = propertyName(node);
  if (name && SWITCHES.has(name)) return name;
  if (name === 'enabled' && propertyName(unwrap(node).object) === 'elicitation') return 'elicitation.enabled';
  return undefined;
}

const isTrue = (node) => node.type === 'Literal' && node.value === true;

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Read the MCP Apps, Skills and elicitation switches only through mcpClientFeatures.ts' },
    schema: [],
    messages: {
      compare:
        'Comparing {{name}} with true makes an unset switch mean "off", but these features are on unless the '
        + 'user turned them off. Use mcpAppsEnabled(), mcpSkillsEnabled() or mcpElicitationEnabled() from '
        + '@/shared/utils/mcpClientFeatures (mcpAppRuntimeBrokerEnabled() for the sidecar broker).',
    },
  },
  create(context) {
    if (repoPath(context.filename ?? context.getFilename()) === HELPER) return {};
    return {
      BinaryExpression(node) {
        if (!OPERATORS.has(node.operator)) return;
        const name = isTrue(node.right) ? switchName(node.left) : isTrue(node.left) ? switchName(node.right) : undefined;
        if (name) context.report({ node, messageId: 'compare', data: { name } });
      },
    };
  },
};
