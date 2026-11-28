// `npm run build` type-checks every route handler against Next's own signature
// and fails when the request parameter is optional (`GET(request?: Request)`).
// The type check and tests pass, so the mistake only shows after a long build
// (found by the scripted pilot's build, #577). With overloads, Next reads the
// last overload, so that one decides.
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

const MESSAGE = 'Next fails "npm run build" when a route handler\'s request parameter is optional. '
  + 'Declare it as required (`{{name}}(request: Request)`); tests call it with `new Request(url)`.';

function optional(param) {
  return param?.type === 'AssignmentPattern' || (param?.type === 'Identifier' && param.optional === true);
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Route handlers take a required request parameter, as Next\'s build demands' },
    schema: [],
    messages: { optionalRequest: MESSAGE },
  },
  create(context) {
    const signatures = new Map();
    const record = (name, fn, node) => {
      if (!METHODS.has(name) || !fn) return;
      const entry = signatures.get(name) ?? { overloads: [], body: undefined };
      if (fn.type === 'TSDeclareFunction') entry.overloads.push({ fn, node });
      else entry.body = { fn, node };
      signatures.set(name, entry);
    };
    return {
      'ExportNamedDeclaration > FunctionDeclaration, ExportNamedDeclaration > TSDeclareFunction'(node) {
        record(node.id?.name, node, node);
      },
      'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator'(node) {
        if (node.id.type === 'Identifier' && node.init?.params) record(node.id.name, node.init, node.init);
      },
      'Program:exit'() {
        for (const [name, { overloads, body }] of signatures) {
          const decisive = overloads.at(-1) ?? body;
          if (decisive && optional(decisive.fn.params[0])) context.report({ node: decisive.node, messageId: 'optionalRequest', data: { name } });
        }
      },
    };
  },
};
