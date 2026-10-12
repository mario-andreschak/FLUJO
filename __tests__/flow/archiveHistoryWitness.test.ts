import { createHash } from 'node:crypto';
import { ArchiveHistoryWitness } from './fixtures/archiveHistoryWitness';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
it.each([1, 3, 32])('hashes canonical ASCII strings across %i-character input chunks', size => {
  const content = 'quotes" backslash\\ newline\n tab\t plain';
  const parser = new ArchiveHistoryWitness({ original: hash(content) });
  const json = JSON.stringify({ sdkRequest: { canonicalMessages: [{ id: 'original', content: 'decoy' }] },
    canonicalMessages: [{ id: 'original', content }], other: { content: 'decoy' } });
  for (let offset = 0; offset < json.length; offset += size) parser.push(json.slice(offset, offset + size));
  expect(parser.finish()).toEqual({ id: 'original', sha256: hash(content), characters: content.length });
});
it('decodes split unicode escapes for ASCII fixture characters', () => {
  const parser = new ArchiveHistoryWitness({ original: hash('A') });
  for (const character of '{"canonicalMessages":[{"id":"original","content":"\\u0041"}]}') parser.push(character);
  expect(parser.finish().characters).toBe(1);
});
it('rejects history corruption instead of accepting a raw archive hash alone', () => {
  const parser = new ArchiveHistoryWitness({ original: hash('retained') });
  expect(() => parser.push('{"canonicalMessages":[{"id":"original","content":"changed"}]}')).toThrow('mismatch');
});
it('rejects a missing canonical witness and incomplete escapes', () => {
  const missing = new ArchiveHistoryWitness({ original: hash('retained') });
  missing.push('{"canonicalMessages":[]}');
  expect(() => missing.finish()).toThrow('Incomplete');
  const broken = new ArchiveHistoryWitness({ original: hash('retained') });
  broken.push('{"canonicalMessages":[{"id":"original","content":"\\u00');
  expect(() => broken.finish()).toThrow('Incomplete');
});
