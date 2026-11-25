const WORKAROUND = /\b(?:work[- ]?arounds?|hack(?:s|y|ed)?|kludge|quick[- ]fix(?:es)?|for now|stop-?gap|band-?aid)\b/i;

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow comments that justify a workaround instead of fixing the cause' },
    schema: [],
    messages: {
      workaround:
        'This comment explains a workaround ("{{phrase}}") instead of fixing it. The next agent copies '
        + 'the workaround because it looks like the house pattern. Fix the root cause. If the constraint '
        + 'is real, enforce it with a type, test or lint rule (AGENTS.md: Corrections become checks).',
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const match = WORKAROUND.exec(comment.value);
          if (match) context.report({ loc: comment.loc, messageId: 'workaround', data: { phrase: match[0] } });
        }
      },
    };
  },
};
