'use client';
import { useEffect, useRef, useState } from 'react';
import type { AvatarConnectionCandidate, AvatarConnectionDiscovery } from '@/shared/types/avatar';
import type { Model } from '@/shared/types/model';
import type { ModelTestResult } from '@/shared/types/model/response';
import { worldCopy, type WorldLocale } from './copy';
import styles from './world.module.css';

export default function ConnectionSetup({ locale, onClose, onVerified, onOther }: { locale: WorldLocale; onClose: () => void; onVerified: () => Promise<void>; onOther: () => void }) {
  const c = worldCopy(locale);
  const [discovery, setDiscovery] = useState<AvatarConnectionDiscovery | null>(null);
  const [candidate, setCandidate] = useState<AvatarConnectionCandidate | null>(null);
  const [choice, setChoice] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<ModelTestResult | null>(null);
  const savedDraft = useRef<{ signature: string; id: string } | null>(null);
  const sheet = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    sheet.current?.focus();
    return () => { previous?.focus(); };
  }, []);
  const refresh = async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch('/api/avatar/connections');
      if (!response.ok) throw new Error(`Flujo (${response.status})`);
      setDiscovery(await response.json());
    } catch (err) { setError(err instanceof Error ? err.message : c.unavailable); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); /* User explicitly refreshes discovery after changes. */ }, []);
  const select = (value: AvatarConnectionCandidate) => { setCandidate(value); setChoice(value.modelChoices[0]?.id ?? ''); setToken(''); setTest(null); setError(null); savedDraft.current = null; };
  const verify = async () => {
    if (!candidate || busy) return;
    setBusy(true); setError(null); setTest(null);
    try {
      let id = candidate.modelId;
      if (!id) {
        const signature = JSON.stringify([candidate.id, choice, token]);
        if (savedDraft.current?.signature === signature) id = savedDraft.current.id;
        else {
          const model: Model = { id: crypto.randomUUID(), name: choice.trim(), displayName: `${candidate.label} · ${choice.trim()}`,
            ApiKey: candidate.kind === 'claude-subscription' ? token.trim() : '',
            provider: candidate.kind === 'claude-subscription' ? 'claude-subscription' : 'codex',
            adapter: candidate.kind === 'claude-subscription' ? 'claude-cli' : 'codex-cli', supportsTools: true };
          const created = await fetch('/api/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(model) });
          const value = await created.json().catch(() => null);
          if (!created.ok) throw new Error(value?.error || `Flujo (${created.status})`);
          id = value.id;
          savedDraft.current = { signature, id: id! };
        }
      }
      const response = await fetch('/api/avatar/work-model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId: id }) });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || `Flujo (${response.status})`);
      setTest(result.test);
      if (result.ready) { setToken(''); await onVerified(); onClose(); }
      else setError(c.connectFailed);
    } catch (err) { setError(err instanceof Error ? err.message : c.connectFailed); }
    finally { setBusy(false); }
  };
  const description = (value: AvatarConnectionCandidate) => value.runtime === 'missing' ? c.runtimeMissing
    : value.authentication === 'login-detected' ? c.login : value.authentication === 'configured' ? c.saved
      : value.authentication === 'incompatible' ? c.incompatible : value.authentication === 'unknown' ? c.unknown
        : value.kind === 'claude-subscription' ? c.needsToken : c.needsLogin;
  return <section ref={sheet} tabIndex={-1} className={styles.setup} role="dialog" aria-modal="true" aria-labelledby="world-setup-title" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onClose(); }
    if (event.key !== 'Tab') return;
    const controls = [...(sheet.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]') ?? [])];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet.current)) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && (document.activeElement === last || document.activeElement === sheet.current)) { event.preventDefault(); first?.focus(); }
  }}>
    <div className={styles.sheetHead}><span className={styles.eyebrow}>FLUJO</span><button onClick={onClose} disabled={busy} aria-label={c.close}>×</button></div>
    <h2 id="world-setup-title">{c.connect}</h2><p>{c.discoveryNote}</p>
    {loading && <p role="status">{c.scanning}</p>}
    {!candidate && <div className={styles.candidates}>
      {discovery?.candidates.map(value => <button key={value.id} type="button" className={styles.candidate} onClick={() => select(value)}>
        <span>{value.kind === 'saved-model' ? '◈' : value.kind === 'codex-subscription' ? '◎' : '✳'}</span>
        <div><strong>{value.label}</strong><small>{description(value)}</small></div><span>↗</span>
      </button>)}
      <button className={styles.candidate} onClick={onOther}><span>＋</span><div><strong>{c.other}</strong><small>Ollama · OpenRouter · API</small></div><span>↗</span></button>
    </div>}
    {candidate && <div className={styles.connectionForm}>
      <button className={styles.textButton} onClick={() => { setCandidate(null); setToken(''); }} disabled={busy}>← {c.back}</button>
      <h3>{candidate.label}</h3><p>{description(candidate)}</p>
      {candidate.kind === 'codex-subscription' && candidate.authentication !== 'login-detected' && <p className={styles.help}>{c.codexHelp}</p>}
      {candidate.kind === 'claude-subscription' && <><p className={styles.help}>{c.claudeHelp}</p><label>{c.token}<input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" spellCheck={false} disabled={busy} /></label></>}
      {!candidate.modelId && <><label>{c.model}<input list="avatar-model-choices" value={choice} onChange={event => setChoice(event.target.value)} disabled={busy} maxLength={128} autoComplete="off" /></label><datalist id="avatar-model-choices">{candidate.modelChoices.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist><small>{c.fallback}</small></>}
      <button className={styles.primary} onClick={() => void verify()} disabled={busy || !choice || candidate.runtime !== 'available' || candidate.kind === 'claude-subscription' && !token.trim()
        || candidate.kind === 'codex-subscription' && candidate.authentication !== 'login-detected'}>{busy ? c.verifying : c.verify}</button>
      {candidate.runtime !== 'available' && <button onClick={onOther} disabled={busy}>{c.other}</button>}
    </div>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {test && <details className={styles.testDetails}><summary>{test.diagnosis}</summary><pre>{JSON.stringify({ model: test.model, adapter: test.adapter, tool: test.tool }, null, 2)}</pre></details>}
    <button className={styles.textButton} onClick={() => { setCandidate(null); void refresh(); }} disabled={busy || loading}>↻ {c.retry}</button>
  </section>;
}
