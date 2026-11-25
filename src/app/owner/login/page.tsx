'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import FirstOwnerPairing from '@/frontend/components/FirstOwnerPairing';
import { useRouter } from 'next/navigation';

/** `off` shows the owner credential page, also while the check is still running; `on` and `damaged` belong to multi-user mode. */
type AccountMode = 'off' | 'on' | 'damaged';

function returnDestination(): string {
  const returnTo = new URLSearchParams(window.location.search).get('returnTo');
  if (returnTo && /^\/(?![\\/])/.test(returnTo) && !/[\x00-\x1f\x7f]/.test(returnTo)) {
    const target = new URL(returnTo, window.location.origin);
    if (target.origin === window.location.origin && target.pathname !== '/owner/login') {
      return target.pathname + target.search + target.hash;
    }
  }
  return '/';
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === 'object' ? { ...body } : {};
  } catch {
    return {};
  }
}

async function readAccountMode(signal: AbortSignal): Promise<{ mode: AccountMode; displayName: string | null }> {
  const response = await fetch('/api/accounts/session', { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok && response.status !== 503) return { mode: 'off', displayName: null };
  const body = await readBody(response);
  if (body.mode === 'damaged' || body.code === 'ACCOUNTS_DAMAGED') return { mode: 'damaged', displayName: null };
  if (!response.ok || body.mode !== 'on') return { mode: 'off', displayName: null };
  const user = body.user && typeof body.user === 'object' ? { ...body.user } : null;
  return {
    mode: 'on',
    displayName: user && 'displayName' in user && typeof user.displayName === 'string' ? user.displayName : null,
  };
}

export default function OwnerLoginPage() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<AccountMode>('off');
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { ++generation.current; requestRef.current?.abort(); }, []);

  useEffect(() => {
    const check = new AbortController();
    readAccountMode(check.signal)
      .then(result => {
        if (check.signal.aborted) return;
        setMode(result.mode);
        setSignedInAs(result.displayName);
      })
      .catch(() => { if (!check.signal.aborted) setMode('off'); });
    return () => check.abort();
  }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestRef.current) return;
    const request = new AbortController(); requestRef.current = request;
    const captured = generation.current;
    const current = () => captured === generation.current && !request.signal.aborted;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/owner/session', {
        method: 'POST', credentials: 'same-origin', signal: request.signal,
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!current()) return;
      if (response.ok) { router.replace(returnDestination()); router.refresh(); }
      else setMessage(response.status === 403
        ? 'This credential or browser origin is not authorized.'
        : response.status === 401 ? 'The credential is invalid, expired or revoked.'
          : 'Owner authentication is unavailable. Check the owner policy and browser origin configuration.');
    } catch { if (current()) setMessage('Could not reach owner authentication.'); }
    finally {
      if (captured === generation.current) { setToken(''); setBusy(false); requestRef.current = null; }
    }
  }

  async function logout() {
    if (requestRef.current) return;
    const request = new AbortController(); requestRef.current = request;
    const captured = generation.current;
    const current = () => captured === generation.current && !request.signal.aborted;
    setToken(''); setBusy(true);
    try {
      const response = await fetch('/api/owner/session', { method: 'DELETE', credentials: 'same-origin', signal: request.signal });
      if (!current()) return;
      setMessage(response.ok ? 'Signed out.' : 'Could not sign out.');
    } catch { if (current()) setMessage('Could not reach owner authentication.'); }
    finally { if (captured === generation.current) { setBusy(false); requestRef.current = null; } }
  }

  async function accountSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestRef.current) return;
    const request = new AbortController(); requestRef.current = request;
    const captured = generation.current;
    const current = () => captured === generation.current && !request.signal.aborted;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/accounts/session', {
        method: 'POST', credentials: 'same-origin', signal: request.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password }),
      });
      if (!current()) return;
      if (response.ok) { router.replace(returnDestination()); router.refresh(); return; }
      const body = await readBody(response);
      if (!current()) return;
      setMessage(typeof body.error === 'string' && body.error ? body.error : 'Could not sign in. Try again.');
    } catch { if (current()) setMessage('Could not reach FLUJO. Check that it is still running.'); }
    finally {
      if (captured === generation.current) { setPassword(''); setBusy(false); requestRef.current = null; }
    }
  }

  async function accountSignOut() {
    if (requestRef.current) return;
    const request = new AbortController(); requestRef.current = request;
    const captured = generation.current;
    const current = () => captured === generation.current && !request.signal.aborted;
    setPassword(''); setBusy(true);
    try {
      const response = await fetch('/api/accounts/session', { method: 'DELETE', credentials: 'same-origin', signal: request.signal });
      if (!current()) return;
      if (response.ok) setSignedInAs(null);
      setMessage(response.ok ? 'Signed out.' : 'Could not sign out.');
    } catch { if (current()) setMessage('Could not reach FLUJO. Check that it is still running.'); }
    finally { if (captured === generation.current) { setBusy(false); requestRef.current = null; } }
  }

  if (mode === 'damaged') {
    return <main className="mx-auto max-w-md p-8">
      <h1 className="mb-4 text-2xl font-semibold">Sign in to FLUJO</h1>
      <p role="alert">
        Sign-in is unavailable because the accounts file on the server is damaged. An admin must fix that file on the server.
      </p>
    </main>;
  }

  if (mode === 'on') {
    return <main className="mx-auto max-w-md p-8">
      <h1 className="mb-4 text-2xl font-semibold">Sign in to FLUJO</h1>
      <p className="mb-4">{signedInAs ? `Signed in as ${signedInAs}.` : 'Sign in with your name and password.'}</p>
      <form onSubmit={accountSignIn}>
        <label htmlFor="account-name">Name</label>
        <input id="account-name" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={name}
          onChange={event => setName(event.target.value)} disabled={busy}
          className="mb-4 mt-1 w-full rounded border p-2" />
        <label htmlFor="account-password">Password</label>
        <input id="account-password" type="password" autoComplete="current-password" required value={password}
          onChange={event => setPassword(event.target.value)} disabled={busy}
          className="mb-4 mt-1 w-full rounded border p-2" />
        <button type="submit" disabled={busy} className="rounded border px-4 py-2">Sign in</button>
      </form>
      <button type="button" disabled={busy} onClick={accountSignOut} className="mt-4 rounded border px-4 py-2">Sign out</button>
      {message && <p role="status" className="mt-4">{message}</p>}
    </main>;
  }

  return <main className="mx-auto max-w-md p-8">
    <h1 className="mb-4 text-2xl font-semibold">Owner sign in</h1>
    <p className="mb-4">Use an owner credential to sign in to this browser. Your credential is cleared after the request.</p>
    <form onSubmit={login}>
      <label htmlFor="owner-credential">Owner credential</label>
      <input id="owner-credential" type="password" autoComplete="off" required value={token}
        onChange={event => setToken(event.target.value)} disabled={busy}
        className="mb-4 mt-1 w-full rounded border p-2" />
      <button type="submit" disabled={busy} className="rounded border px-4 py-2">Sign in</button>
    </form>
    <button type="button" disabled={busy} onClick={logout} className="mt-4 rounded border px-4 py-2">Sign out</button>
    {message && <p role="status" className="mt-4">{message}</p>}
    <FirstOwnerPairing />
  </main>;
}
