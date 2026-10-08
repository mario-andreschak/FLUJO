import { magicLinkPath, magicLinkUrl, type MagicLinkTarget } from '@/frontend/utils/magicLink';

describe('magicLinkPath', () => {
  it('builds a flow dashboard link', () => {
    expect(magicLinkPath({ kind: 'flow', id: 'abc' })).toBe('/flows?flow=abc');
  });

  it('builds a flow editor link', () => {
    expect(magicLinkPath({ kind: 'flow-editor', id: 'abc' })).toBe('/flows?flow=abc&mode=edit');
  });

  it('builds a conversation link', () => {
    expect(magicLinkPath({ kind: 'conversation', id: 'conv-1' })).toBe('/chat?conversation=conv-1');
  });

  it('builds a message link that includes the parent conversation', () => {
    const path = magicLinkPath({ kind: 'message', id: 'msg-1', extra: { conversation: 'conv-1' } });
    const params = new URLSearchParams(path.split('?')[1]);
    expect(path.startsWith('/chat?')).toBe(true);
    expect(params.get('conversation')).toBe('conv-1');
    expect(params.get('message')).toBe('msg-1');
  });

  it('builds a model link', () => {
    expect(magicLinkPath({ kind: 'model', id: 'gpt-4' })).toBe('/models?edit=gpt-4');
  });

  it('builds an mcp-server link', () => {
    expect(magicLinkPath({ kind: 'mcp-server', id: 'my-server' })).toBe('/mcp?server=my-server');
  });

  it('encodes ids containing reserved characters', () => {
    const path = magicLinkPath({ kind: 'flow', id: 'a/b?c d' });
    expect(path).toBe('/flows?flow=a%2Fb%3Fc+d');
    // Round-trips back to the original id via URLSearchParams decoding.
    const params = new URLSearchParams(path.split('?')[1]);
    expect(params.get('flow')).toBe('a/b?c d');
  });

  it('merges extra params verbatim', () => {
    const path = magicLinkPath({ kind: 'flow-editor', id: 'abc', extra: { node: 'n1' } });
    const params = new URLSearchParams(path.split('?')[1]);
    expect(params.get('node')).toBe('n1');
    expect(params.get('mode')).toBe('edit');
  });

  it('fails closed (returns "/") for a missing id, without throwing', () => {
    expect(() => magicLinkPath({ kind: 'flow', id: '' })).not.toThrow();
    expect(magicLinkPath({ kind: 'flow', id: '' })).toBe('/');
  });

  it('fails closed (returns "/") for an unknown kind, without throwing', () => {
    const target = { kind: 'not-a-real-kind', id: 'x' } as unknown as MagicLinkTarget;
    expect(() => magicLinkPath(target)).not.toThrow();
    expect(magicLinkPath(target)).toBe('/');
  });
});

describe('magicLinkUrl', () => {
  it('keeps an explicit default workspace when window is unavailable (node/SSR)', () => {
    expect(magicLinkUrl({ kind: 'flow', id: 'abc' }))
      .toBe('/flows?flow=abc&workspace=default-workspace');
  });
});
