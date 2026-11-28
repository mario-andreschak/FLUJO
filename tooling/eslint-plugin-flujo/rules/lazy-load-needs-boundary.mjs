// A lazily loaded piece fails when its chunk does not arrive (a slow PC, a busy server). With a bare
// next/dynamic or React.lazy that failure reaches the app's error boundary and replaces the whole screen.
// src/frontend/lazy gives every lazy piece a boundary of its own and picks the recovery by what it is.

function isReactSource(node) {
  return node.source.value === 'react';
}

function reactBindings(program) {
  const lazyNames = new Set();
  const namespaces = new Set();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || !isReactSource(statement)) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.imported.name === 'lazy') lazyNames.add(specifier.local.name);
      else if (specifier.type !== 'ImportSpecifier') namespaces.add(specifier.local.name);
    }
  }
  return { lazyNames, namespaces };
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Lazy pieces load through src/frontend/lazy so a failed chunk never takes down the screen' },
    schema: [],
    messages: {
      bareLazyLoad:
        '`{{name}}` loads a piece without a boundary of its own, so one slow or failed chunk replaces the whole '
        + 'screen with the error page. Use lazyOptional from src/frontend/lazy for pieces the screen works without '
        + '(decorations, overlays, docks): it shows nothing and loads again later by itself. Use lazyEssential for '
        + 'pieces the screen needs: it fetches a failed chunk again with backoff first. A Server Component imports '
        + 'Client Components directly; the route already loads them as chunks of its own.',
    },
  },
  create(context) {
    let react = { lazyNames: new Set(), namespaces: new Set() };
    const report = (node, name) => context.report({ node, messageId: 'bareLazyLoad', data: { name } });
    return {
      Program(program) {
        react = reactBindings(program);
      },
      ImportDeclaration(node) {
        if (node.source.value === 'next/dynamic') report(node, 'next/dynamic');
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal' && node.source.value === 'next/dynamic') report(node, 'next/dynamic');
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type === 'Identifier' && react.lazyNames.has(callee.name)) {
          report(node, 'React.lazy');
        } else if (
          callee.type === 'MemberExpression'
          && !callee.computed
          && callee.object.type === 'Identifier'
          && react.namespaces.has(callee.object.name)
          && callee.property.type === 'Identifier'
          && callee.property.name === 'lazy'
        ) {
          report(node, 'React.lazy');
        } else if (
          callee.type === 'Identifier'
          && callee.name === 'require'
          && node.arguments[0]?.type === 'Literal'
          && node.arguments[0].value === 'next/dynamic'
        ) {
          report(node, 'next/dynamic');
        }
      },
    };
  },
};
