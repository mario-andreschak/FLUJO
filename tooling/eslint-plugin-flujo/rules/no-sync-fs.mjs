const FS_MODULES = new Set(['fs', 'node:fs', 'fs-extra', 'graceful-fs']);
const isSync = (name) => typeof name === 'string' && /^[a-z][A-Za-z]*Sync$/.test(name);
const propertyName = (node) => (node.type === 'Identifier' ? node.name : node.type === 'Literal' ? node.value : undefined);
const messageFor = (name) => (name === 'realpathSync' ? 'syncRealpath' : 'syncFs');
const isFsRequire = (node) => node?.type === 'CallExpression'
  && node.callee.type === 'Identifier'
  && node.callee.name === 'require'
  && node.arguments[0]?.type === 'Literal'
  && FS_MODULES.has(node.arguments[0].value);

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow synchronous file system calls in server code' },
    schema: [],
    messages: {
      syncFs:
        '`{{name}}` blocks the event loop, which stalls every chat, flow and request in FLUJO while the disk '
        + 'answers. Use the async API (`node:fs/promises`). If this truly runs once before the server accepts '
        + 'work, keep it with `// eslint-disable-next-line flujo/no-sync-fs -- <why>`.',
      syncRealpath:
        '`realpathSync` blocks the event loop. Use `realpath` from `@/utils/realpath`: it returns the same path '
        + 'without blocking. `fs.promises.realpath` is not a drop-in replacement: on Windows it expands short names '
        + '(`RUNNER~1`) and changes letter case, so a check that compares the result with the original path refuses '
        + 'valid paths.',
    },
  },
  create(context) {
    const namespaces = new Set();
    const syncBindings = new Map();

    const addPattern = (pattern) => {
      if (pattern.type === 'Identifier') namespaces.add(pattern.name);
      if (pattern.type !== 'ObjectPattern') return;
      for (const property of pattern.properties) {
        if (property.type !== 'Property' || property.computed) continue;
        const key = propertyName(property.key);
        const local = property.value.type === 'AssignmentPattern' ? property.value.left : property.value;
        if (isSync(key) && local.type === 'Identifier') syncBindings.set(local.name, key);
      }
    };

    return {
      ImportDeclaration(node) {
        if (!FS_MODULES.has(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier') {
            const imported = propertyName(specifier.imported);
            if (isSync(imported)) syncBindings.set(specifier.local.name, imported);
          } else {
            namespaces.add(specifier.local.name);
          }
        }
      },
      VariableDeclarator(node) {
        if (isFsRequire(node.init)) addPattern(node.id);
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type === 'Identifier' && syncBindings.has(callee.name)) {
          const name = syncBindings.get(callee.name);
          context.report({ node, messageId: messageFor(name), data: { name } });
          return;
        }
        if (callee.type !== 'MemberExpression') return;
        const name = callee.computed ? propertyName(callee.property) : callee.property.name;
        if (!isSync(name)) return;
        const fromNamespace = callee.object.type === 'Identifier' && namespaces.has(callee.object.name);
        if (fromNamespace || isFsRequire(callee.object)) {
          context.report({ node, messageId: messageFor(name), data: { name } });
        }
      },
    };
  },
};
