import { runInNewContext } from 'node:vm';
import JSZip from 'jszip';

const original = Buffer.from([0, 255, 17, 128, 42]);

function foreignBytes(bytes: Buffer, type: 'ArrayBuffer' | 'Uint8Array'): ArrayBuffer | Uint8Array {
  return runInNewContext(
    `const padded = new Uint8Array([99, ...bytes, 88]);
     const member = padded.subarray(1, padded.length - 1);
     type === 'ArrayBuffer' ? member.slice().buffer : member;`,
    { bytes: Array.from(bytes), type },
  );
}

describe('public ZIP binary compatibility', () => {
  it.each(['ArrayBuffer', 'Uint8Array'] as const)('writes %s from another context without padding bytes', async (type) => {
    const zip = new JSZip();
    zip.file('member.bin', foreignBytes(original, type));
    const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const restored = await JSZip.loadAsync(archive, { checkCRC32: true });
    expect(await restored.file('member.bin')!.async('nodebuffer')).toEqual(original);
  });

  it.each(['ArrayBuffer', 'Uint8Array'] as const)('reads an archive from another context as %s', async (type) => {
    const zip = new JSZip();
    zip.file('member.bin', original);
    const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', streamFiles: true });
    const restored = await JSZip.loadAsync(foreignBytes(archive, type), { checkCRC32: true });
    expect(await restored.file('member.bin')!.async('nodebuffer')).toEqual(original);
  });

  it('writes a native Blob with the original nonempty binary bytes', async () => {
    const zip = new JSZip();
    zip.file('member.bin', new Blob([original]));
    const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const restored = await JSZip.loadAsync(archive, { checkCRC32: true });
    expect(await restored.file('member.bin')!.async('nodebuffer')).toEqual(original);
  });

  it('reads a native Blob archive including a Unicode member name', async () => {
    const zip = new JSZip();
    zip.file('记忆.bin', original);
    const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', streamFiles: true });
    const restored = await JSZip.loadAsync(new Blob([new Uint8Array(archive)]), { checkCRC32: true });
    expect(await restored.file('记忆.bin')!.async('nodebuffer')).toEqual(original);
  });
});
