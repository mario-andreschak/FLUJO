// Short-lived file errors (antivirus or the indexer holding a file, a reader
// keeping it open while Windows refuses a rename) are waited out in one place:
// src/utils/transientFileRetry.ts. Hand-written copies of that loop drifted
// apart: different error codes, no cancellation, no diagnostics, and places
// that refused at once (issue #1050).
const RETRY_ONLY_CODES = new Set(['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE']);
const LOCK_CODES = new Set(['EPERM', 'EACCES']);
// On Windows, renaming a directory onto an existing one fails with EPERM or
// EACCES. A catch that also names these codes is detecting such a collision.
const COLLISION_CODES = new Set(['EEXIST', 'ENOTEMPTY']);
const LOOPS = new Set(['ForStatement', 'WhileStatement', 'DoWhileStatement']);
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

const stringValue = (node) => {
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : undefined;
  return node.expressions.length === 0 ? node.quasis[0].value.cooked : undefined;
};

function insideRetryLoop(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (FUNCTIONS.has(current.type)) return false;
    if (LOOPS.has(current.type)) return true;
  }
  return false;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Wait out short-lived file errors only through src/utils/transientFileRetry.ts' },
    schema: [],
    messages: {
      retryCode:
        '"{{code}}" only means "try again". Wrap the file call in retryTransientFileOperation, or a rename in '
        + "replaceFileWithRetry, from '@/utils/transientFileRetry'; to classify an error, call isTransientFileError.",
      retryLoop:
        'This loop retries a short-lived file error by hand. Call retryTransientFileOperation, or for a rename '
        + "replaceFileWithRetry, from '@/utils/transientFileRetry' with a label, and pass beforeAttempt or isTransient for extra checks.",
    },
  },
  create(context) {
    const openCatches = [];
    const visitString = (node) => {
      const value = stringValue(node);
      if (value === undefined) return;
      if (RETRY_ONLY_CODES.has(value)) context.report({ node, messageId: 'retryCode', data: { code: value } });
      for (const open of openCatches) open.codes.add(value);
    };
    return {
      Literal: visitString,
      TemplateLiteral: visitString,
      CatchClause(node) {
        openCatches.push({ node, codes: new Set(), classifies: false, loop: insideRetryLoop(node) });
      },
      'CatchClause CallExpression[callee.name="isTransientFileError"]'() {
        for (const open of openCatches) open.classifies = true;
      },
      'CatchClause:exit'(node) {
        const open = openCatches.pop();
        if (!open || open.node !== node || !open.loop) return;
        const codes = [...open.codes];
        const locks = codes.some((code) => LOCK_CODES.has(code)) && !codes.some((code) => COLLISION_CODES.has(code));
        if (locks || open.classifies) context.report({ node, messageId: 'retryLoop' });
      },
    };
  },
};
