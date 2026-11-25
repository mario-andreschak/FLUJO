import fs from 'node:fs';
import path from 'node:path';

/**
 * Issue #1352: each chat keeps small records beside it (its sidebar summary and
 * its project folder). A chat deletion that forgets one leaves a stale record
 * behind for good. Every place that deletes a chat file must also delete them.
 */
const SOURCE_ROOT = path.join(process.cwd(), 'src');
const DELETES_CHAT = /deleteCollectionItem\(\s*['"]conversations['"]/;
const REQUIRED_CLEANUP = ['deleteConversationSummary(', 'deleteChatProject('];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe('deleting a chat', () => {
  it('also deletes the records kept beside it', () => {
    const deleters = sourceFiles(SOURCE_ROOT).filter(file => DELETES_CHAT.test(fs.readFileSync(file, 'utf8')));
    expect(deleters.length).toBeGreaterThan(0);
    const offenders = deleters.flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      const missing = REQUIRED_CLEANUP.filter(call => !source.includes(call));
      return missing.length > 0 ? [`${path.relative(process.cwd(), file)}: missing ${missing.join(', ')}`] : [];
    });
    if (offenders.length > 0) {
      throw new Error('A chat deletion must also call deleteConversationSummary and deleteChatProject '
        + `(src/backend/services/projects/chatProjectBindings.ts):\n${offenders.join('\n')}`);
    }
  });
});
