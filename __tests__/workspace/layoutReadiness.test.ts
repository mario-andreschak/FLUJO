import {
  failWorkspaceLayoutPreparation,
  getWorkspaceLayoutPreparation,
  getWorkspaceLayoutStatus,
  setWorkspaceLayoutPreparation,
  waitForWorkspaceLayoutReady,
} from '@/backend/services/workspace/layoutReadiness';

afterEach(() => setWorkspaceLayoutPreparation(undefined));

it('retains the original startup failure for later requests while allowing a retry', async () => {
  const failure = Object.assign(new Error('Damaged workspace capture lock'), {
    code: 'PERSONA_RUNTIME_LOCK_CORRUPT',
  });
  const failed = Promise.reject(failure);
  setWorkspaceLayoutPreparation(failed);
  await expect(waitForWorkspaceLayoutReady()).rejects.toBe(failure);
  failWorkspaceLayoutPreparation(failed, failure);
  expect(getWorkspaceLayoutPreparation()).toBeUndefined();
  expect(getWorkspaceLayoutStatus()).toBe('failed');
  await expect(waitForWorkspaceLayoutReady()).rejects.toBe(failure);

  setWorkspaceLayoutPreparation(Promise.resolve());
  await expect(waitForWorkspaceLayoutReady()).resolves.toBeUndefined();
  expect(getWorkspaceLayoutStatus()).toBe('ready');
  expect(global.__flujo_workspace_layout_error).toBeUndefined();
});

it('does not let an old failed attempt replace a successful successor', async () => {
  let rejectOld!: (error: Error) => void;
  const old = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
  setWorkspaceLayoutPreparation(old);
  setWorkspaceLayoutPreparation(Promise.resolve());
  const failure = new Error('Old preparation failed');
  rejectOld(failure);
  failWorkspaceLayoutPreparation(old, failure);
  await expect(waitForWorkspaceLayoutReady()).resolves.toBeUndefined();
  expect(getWorkspaceLayoutStatus()).toBe('ready');
  expect(global.__flujo_workspace_layout_error).toBeUndefined();
});

it('reports not started only before any preparation has run or after an explicit reset', async () => {
  setWorkspaceLayoutPreparation(undefined);
  await expect(waitForWorkspaceLayoutReady()).rejects.toMatchObject({
    code: 'WORKSPACE_LAYOUT_NOT_STARTED',
  });
});

it('lets a request that arrives before startup began preparing wait for it (#757)', async () => {
  setWorkspaceLayoutPreparation(undefined);
  const waiting = waitForWorkspaceLayoutReady({ deadline: Date.now() + 5000 });
  let settled = false;
  void waiting.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  setWorkspaceLayoutPreparation(Promise.resolve());
  await expect(waiting).resolves.toBeUndefined();
});

it('still reports not started when startup does not begin before the wait ends', async () => {
  setWorkspaceLayoutPreparation(undefined);
  const caller = new AbortController();
  const leaving = waitForWorkspaceLayoutReady({ deadline: Date.now() + 5000, signal: caller.signal });
  caller.abort();
  await expect(leaving).rejects.toMatchObject({ code: 'WORKSPACE_LAYOUT_NOT_STARTED' });
  await expect(waitForWorkspaceLayoutReady({ deadline: Date.now() + 30 })).rejects.toMatchObject({ code: 'WORKSPACE_LAYOUT_NOT_STARTED' });
});
