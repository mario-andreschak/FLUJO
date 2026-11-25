const TIMERS = new Set(['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback']);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);

function isLocallyDeclared(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name);
    if (variable) return variable.defs.length > 0;
  }
  return false;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow raw timers in UI code; use the timing hooks' },
    schema: [],
    messages: {
      rawTimer:
        '`{{name}}` in UI code usually patches over an ordering problem (a flicker, a value that is not '
        + 'ready yet), and copies of it pile up and slow the app down. Derive the value during render or '
        + 'react to the real event. If a delay is the actual behaviour (debounce, polling, auto-hide), use '
        + 'useTimeout, useInterval, useDebouncedValue or useDebouncedCallback from src/frontend/hooks/timing.ts.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        let name;
        if (callee.type === 'Identifier' && TIMERS.has(callee.name)) {
          if (isLocallyDeclared(context.sourceCode.getScope(node), callee.name)) return;
          name = callee.name;
        } else if (
          callee.type === 'MemberExpression'
          && !callee.computed
          && callee.object.type === 'Identifier'
          && GLOBAL_OBJECTS.has(callee.object.name)
          && callee.property.type === 'Identifier'
          && TIMERS.has(callee.property.name)
        ) {
          name = `${callee.object.name}.${callee.property.name}`;
        }
        if (name) context.report({ node, messageId: 'rawTimer', data: { name } });
      },
    };
  },
};
