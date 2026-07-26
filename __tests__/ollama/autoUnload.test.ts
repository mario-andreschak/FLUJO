import { normaliseOllamaRoot, withOllamaLock, getLoadedModel, setLoadedModel, clearRegistry } from '../../src/backend/services/ollama/modelRegistry';

beforeEach(() => clearRegistry());

describe('normaliseOllamaRoot', () => {
  it('strips /v1 suffix', () => {
    expect(normaliseOllamaRoot('http://localhost:11434/v1')).toBe('http://localhost:11434');
  });
  it('strips /v1/ suffix', () => {
    expect(normaliseOllamaRoot('http://localhost:11434/v1/')).toBe('http://localhost:11434');
  });
  it('leaves bare root unchanged', () => {
    expect(normaliseOllamaRoot('http://192.168.1.10:11434')).toBe('http://192.168.1.10:11434');
  });
});

describe('registry read/write', () => {
  it('returns null when empty', () => {
    expect(getLoadedModel('http://localhost:11434')).toBeNull();
  });
  it('stores and retrieves model name', () => {
    setLoadedModel('http://localhost:11434', 'llama3.2:3b');
    expect(getLoadedModel('http://localhost:11434')).toBe('llama3.2:3b');
  });
});

describe('withOllamaLock', () => {
  it('serialises concurrent calls on the same root', async () => {
    const root = 'http://localhost:11434';
    const order: number[] = [];
    const p1 = withOllamaLock(root, async () => {
      await new Promise(r => setTimeout(r, 20));
      order.push(1);
    });
    const p2 = withOllamaLock(root, async () => {
      order.push(2);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it('allows concurrent calls on different roots', async () => {
    const finished: string[] = [];
    const p1 = withOllamaLock('http://host1:11434', async () => {
      await new Promise(r => setTimeout(r, 20));
      finished.push('host1');
    });
    const p2 = withOllamaLock('http://host2:11434', async () => {
      finished.push('host2');
    });
    await Promise.all([p1, p2]);
    // host2 should finish first (no lock contention)
    expect(finished[0]).toBe('host2');
    expect(finished[1]).toBe('host1');
  });
});
