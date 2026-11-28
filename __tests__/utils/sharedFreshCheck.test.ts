/** #757: callers asking together share a check, and no answer is older than its question. */
import { SharedFreshChecks, sharedFreshCheck } from '@/utils/sharedFreshCheck';

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}

it('lets callers that ask while a check runs share the next one, which starts after they asked', async () => {
  const started: number[] = [];
  const gates = [gate(), gate()];
  let calls = 0;
  const check = sharedFreshCheck(async () => {
    const call = calls++;
    started.push(call);
    await gates[call].opened;
    return call;
  });
  const first = check();
  await Promise.resolve();
  const asked = [check(), check(), check()];
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(started).toEqual([0]);
  gates[0].open();
  await expect(first).resolves.toBe(0);
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(started).toEqual([0, 1]);
  gates[1].open();
  await expect(Promise.all(asked)).resolves.toEqual([1, 1, 1]);
  expect(calls).toBe(2);
  // Nothing is kept: the next question checks again.
  gates.push(gate());
  const later = check();
  gates[2].open();
  await expect(later).resolves.toBe(2);
});

it('gives every sharer the failure and checks afresh afterwards', async () => {
  let fail = true;
  const check = sharedFreshCheck(async () => { if (fail) throw new Error('lost'); return 'owned'; });
  const both = [check(), check()];
  await expect(both[0]).rejects.toThrow('lost');
  await expect(both[1]).rejects.toThrow('lost');
  fail = false;
  await expect(check()).resolves.toBe('owned');
});

it('keeps different keys apart', async () => {
  const checks = new SharedFreshChecks<string>();
  const seen: string[] = [];
  const results = await Promise.all(['a', 'b', 'a'].map(key => checks.run(key, async () => { seen.push(key); return key; })));
  expect(results).toEqual(['a', 'b', 'a']);
  expect(seen.sort()).toEqual(['a', 'a', 'b']);
});
