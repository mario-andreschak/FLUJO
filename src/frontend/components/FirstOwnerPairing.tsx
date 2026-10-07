"use client";

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export default function FirstOwnerPairing() {
  const router = useRouter();
  const [proof, setProof] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [ownerToken, setOwnerToken] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestRef.current?.abort(); };
  }, []);
  const pair = async (event: FormEvent) => {
    event.preventDefault();
    if (requestRef.current || !confirmed || !/^flo_v1_[A-Za-z0-9_-]{43}$/.test(proof)) return;
    const request = new AbortController(); requestRef.current = request;
    setBusy(true); setError(false);
    try {
      const response = await fetch('/api/owner/bootstrap', { method: 'POST', credentials: 'same-origin',
        cache: 'no-store', signal: request.signal, headers: { Authorization: `Bearer ${proof}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmOwnerEnrollment: true }) });
      const data = await response.json();
      if (!mounted.current || request.signal.aborted) return;
      if (response.status !== 201 || !/^flo_v1_[A-Za-z0-9_-]{43}$/.test(data.ownerToken)
          || typeof data.authenticated !== 'boolean') throw new Error();
      setOwnerToken(data.ownerToken); setAuthenticated(data.authenticated);
    } catch { if (mounted.current) setError(true); }
    finally {
      if (mounted.current) { setProof(''); setConfirmed(false); setBusy(false); requestRef.current = null; }
    }
  };
  return <section className="mt-8 border-t pt-4">
    <h2 className="text-lg font-semibold">Pair the first owner</h2>
    <p>Only a locally provisioned, unexpired pairing capability can enroll an owner. Existing authority is never overwritten.</p>
    {ownerToken ? <>
      <p>Save this new owner credential privately. It is shown once and is not stored in your browser.</p>
      <label htmlFor="new-owner-credential">New owner credential</label>
      <input id="new-owner-credential" readOnly type="password" autoComplete="off" value={ownerToken} className="w-full rounded border p-2" />
      <button type="button" onClick={() => {
        setOwnerToken('');
        if (authenticated) { router.replace('/'); router.refresh(); }
      }}>I saved the credential{authenticated ? '; continue' : '; sign in above'}</button>
    </> : <form onSubmit={pair}>
      <label htmlFor="owner-pairing-capability">Local pairing capability</label>
      <input id="owner-pairing-capability" type="password" autoComplete="off" value={proof} disabled={busy}
        onChange={event => setProof(event.target.value)} className="my-2 w-full rounded border p-2" />
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />
        I authorize enrollment of the first owner.</label>
      <button disabled={busy || !confirmed || !/^flo_v1_[A-Za-z0-9_-]{43}$/.test(proof)} type="submit" className="mt-2 rounded border px-4 py-2">Pair owner</button>
    </form>}
    {busy && <button type="button" onClick={() => { setProof(''); setConfirmed(false); setError(true); requestRef.current?.abort(); }}>Cancel pairing request</button>}
    {error && <p role="status">Pairing could not finish. Preserve existing authority. Check local origin, capability expiry and the private configuration. If enrollment committed, use owner-controlled offline recovery instead of retrying an overwrite.</p>}
  </section>;
}
