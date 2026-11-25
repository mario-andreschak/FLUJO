const isUnknownCast = (node) => (node?.type === 'TSAsExpression' || node?.type === 'TSTypeAssertion')
  && node.typeAnnotation.type === 'TSUnknownKeyword';

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow `as unknown as T` double casts' },
    schema: [],
    messages: {
      doubleCast:
        '`as unknown as` hides a real type mismatch from the compiler. Fix the type where the value '
        + 'comes from, narrow it with a type guard, or parse it (zod) where it enters the program.',
    },
  },
  create(context) {
    const check = (node) => {
      if (isUnknownCast(node.expression)) context.report({ node, messageId: 'doubleCast' });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};
