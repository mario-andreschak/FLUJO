const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.env.FLUJO_APPEND_WITNESS_ROOT;
if (!root) throw new Error('Explicit diagnostic checkout required');
const ts = require(path.join(root, 'node_modules/typescript'));
const swc = require(path.join(root, 'node_modules/next/dist/build/swc/jest-transformer.js'));
const targets = {
  'src/backend/services/workspace/workspaceMutationGate.ts': ['withWorkspaceMutation'],
  'src/backend/services/enduringAgents/runtimeLock.ts': ['registerWorkspaceWriter', 'withWorkspaceProcessMutation', 'acquireFilesystemLock', 'ensureRuntimeLockRoot', 'retireOwnedCanonical'],
  'src/backend/services/enduringAgents/runtimeEvents.ts': ['appendPersonaRuntimeEvent', 'assertEventLogNotDeleting', 'enqueue', 'parseLogLine', 'scanLogLines', 'syncState', 'appendRecord', 'rotateIfNeeded', 'readPersonaRuntimeEvents'],
  'src/backend/services/enduringAgents/store.ts': ['getPersonaDeletionTombstone', 'getRecord'],
  'src/backend/services/enduringAgents/personaRecoveryOrigins.ts': ['getRecoveredPersonaDeletionTombstone'],
  'src/utils/storage/backend.ts': ['loadCollectionItem', 'runInWriteChain'],
};
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
function observe(source, filename) {
  const relative = path.relative(root, filename).replaceAll('\\', '/');
  const requested = targets[relative];
  if (!requested) throw new Error('Unexpected diagnostic transform target: ' + relative);
  if (['__appendWitnessObserver', '__appendWitnessSpan', '__appendWitnessReturn', '__appendWitnessError'].some(name => source.includes(name))) throw new Error('Observer identifier collides with source');
  const syntax = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits = [];
  const found = [];
  for (const statement of syntax.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body || !requested.includes(statement.name.text)) continue;
    const name = statement.name.text;
    found.push(name);
    // Observe the original return only AFTER original finally blocks execute.
    // Promise continuations and delegated task wrappers add diagnostic overhead.
    // The production file on disk and all admission/policy decisions stay intact.
    const task = ['withWorkspaceMutation', 'withWorkspaceProcessMutation', 'registerWorkspaceWriter', 'enqueue', 'runInWriteChain'].includes(name)
      ? 'if (__appendWitnessObserver) task = __appendWitnessObserver.wrapTask(__appendWitnessSpan, task);' : '';
    const prefix = 'const __appendWitnessObserver = (globalThis as any).__flujoAppendPhaseWitness; const __appendWitnessSpan = __appendWitnessObserver?.begin(' + JSON.stringify(name) + ', Array.from(arguments)); let __appendWitnessReturn: unknown; ' + task + ' try {';
    edits.push({ start: statement.body.getStart(syntax) + 1, end: statement.body.getStart(syntax) + 1, text: prefix });
    edits.push({ start: statement.body.end - 1, end: statement.body.end - 1, text: '; } catch (__appendWitnessError) { __appendWitnessObserver?.failed(__appendWitnessSpan, __appendWitnessError); throw __appendWitnessError; } finally { __appendWitnessObserver?.ended(__appendWitnessSpan, __appendWitnessReturn); }' });
    function visit(node) {
      if (node !== statement.body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) {
        const expression = node.expression ? source.slice(node.expression.getStart(syntax), node.expression.end) : 'undefined';
        edits.push({ start: node.getStart(syntax), end: node.end, text: 'return (__appendWitnessReturn = (' + expression + '));' });
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(statement.body);
  }
  if (found.length !== requested.length) throw new Error('Incomplete function observation: ' + relative);
  let output = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  fs.appendFileSync(process.env.FLUJO_APPEND_WITNESS_TRANSFORMS, JSON.stringify({ file: relative, originalSha256: sha(source), observedSha256: sha(output), functions: found }) + '\n');
  return output;
}
module.exports = { createTransformer(options) {
  const delegate = swc.createTransformer(options);
  return { process(source, filename, jestOptions) { return delegate.process(observe(source, filename), filename, jestOptions); } };
} };
