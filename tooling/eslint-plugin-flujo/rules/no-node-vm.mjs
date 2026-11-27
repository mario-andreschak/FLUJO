// Code written by a model runs only in code mode's QuickJS sandbox (#1448).
// Node's `vm` module and `new Function` look like a quick way to run a
// snippet, but neither is a security boundary: the code shares the app's
// process, memory and event loop and can reach Node's APIs through any
// object handed to it.
const VM_MODULES = new Set(['vm', 'node:vm']);

const MESSAGE = 'Node\'s vm module and new Function are not a sandbox: the code shares FLUJO\'s process and can '
  + 'reach its APIs. Run model-written code with runToolScript from '
  + 'src/backend/execution/flow/codeMode/sandbox.ts, which uses a separate QuickJS interpreter with '
  + 'time and memory limits.';

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Run model-written code only in the QuickJS sandbox, never with node:vm or new Function' },
    schema: [],
    messages: { notSandbox: MESSAGE },
  },
  create(context) {
    const isVm = (node) => node?.type === 'Literal' && VM_MODULES.has(node.value);
    return {
      ImportDeclaration(node) {
        if (isVm(node.source)) context.report({ node, messageId: 'notSandbox' });
      },
      ImportExpression(node) {
        if (isVm(node.source)) context.report({ node, messageId: 'notSandbox' });
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require' && isVm(node.arguments[0])) {
          context.report({ node, messageId: 'notSandbox' });
        }
      },
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Function') {
          context.report({ node, messageId: 'notSandbox' });
        }
      },
    };
  },
};
