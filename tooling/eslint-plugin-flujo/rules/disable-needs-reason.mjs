const DIRECTIVE = /^\s*eslint-disable(?:-next-line|-line)?(?=\s|$)(.*)$/s;

export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Require every eslint-disable comment to name its rules and give a reason' },
    schema: [],
    messages: {
      noRule: 'Name the rule you are turning off. A bare eslint-disable silences every check, including future ones.',
      noReason:
        'Say why the rule does not apply here: `// eslint-disable-next-line <rule> -- <reason>`. '
        + 'Prefer fixing the code; a reason is for real exceptions, not for getting past the check.',
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const match = DIRECTIVE.exec(comment.value);
          if (!match) continue;
          const [rules, reason] = match[1].split(/\s--\s?/, 2);
          if (!rules.trim()) context.report({ loc: comment.loc, messageId: 'noRule' });
          else if (!reason?.trim()) context.report({ loc: comment.loc, messageId: 'noReason' });
        }
      },
    };
  },
};
