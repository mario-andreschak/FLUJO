'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export default function OwnerLoginPage() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/owner/session', {
        method: 'POST', credentials: 'same-origin',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        let destination = '/';
        const returnTo = new URLSearchParams(window.location.search).get('returnTo');
        if (returnTo && /^\/(?![\\/])/.test(returnTo) && !/[\x00-\x1f\x7f]/.test(returnTo)) {
          const target = new URL(returnTo, window.location.origin);
          if (target.origin === window.location.origin && target.pathname !== '/owner/login') {
            destination = target.pathname + target.search + target.hash;
          }
        }
        router.replace(destination); router.refresh();
      }
      else setMessage(response.status === 403
        ? 'This credential or browser origin is not authorized.'
        : response.status === 401 ? 'The credential is invalid, expired or revoked.'
          : 'Owner authentication is unavailable. Check the owner policy and browser origin configuration.');
    } catch { setMessage('Could not reach owner authentication.'); }
    finally { setToken(''); setBusy(false); }
  }

  async function logout() {
    setBusy(true);
    try {
      const response = await fetch('/api/owner/session', { method: 'DELETE', credentials: 'same-origin' });
      setMessage(response.ok ? 'Signed out.' : 'Could not sign out.');
    } catch { setMessage('Could not reach owner authentication.'); }
    finally { setBusy(false); }
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
  </main>;
}
