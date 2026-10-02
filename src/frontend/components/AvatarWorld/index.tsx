'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AvatarWorldSnapshot } from '@/shared/types/avatar';
import type { AskFlujoPageContext } from '@/frontend/types/askFlujo';
import { getSelectedWorkspace, workspaceLocalStorageKey } from '@/frontend/utils/workspaceSelection';
import Eyes, { type AvatarStyle } from './Eyes';
import { worldCopy, type WorldLocale } from './copy';
import Watershed, { PLACE_ROUTES, PLACE_KINDS, type WorldPlace } from './Watershed';
import ConnectionSetup from './ConnectionSetup';
import { useAvatarWork } from './useAvatarWork';
import { useWorldPanel } from './useWorldPanel';
import styles from './world.module.css';

export default function AvatarWorld() {
  const [locale, setLocale] = useState<WorldLocale>('es');
  const [avatar, setAvatar] = useState<AvatarStyle>('moss');
  const [snapshot, setSnapshot] = useState<AvatarWorldSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  const [exploring, setExploring] = useState(false);
  const [place, setPlace] = useState<WorldPlace | null>(null);
  const [draft, setDraft] = useState('');
  const [actionResults, setActionResults] = useState<Record<string, string>>({});
  const input = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const c = worldCopy(locale);
  const panel = useWorldPanel(() => input.current?.focus());
  const reload = useCallback(async () => {
    try {
      const response = await fetch('/api/avatar/world');
      if (!response.ok) throw new Error(`Flujo (${response.status})`);
      setSnapshot(await response.json()); setError(null);
    } catch (err) { setError(err instanceof Error ? err.message : 'Flujo unavailable'); }
  }, []);
  useEffect(() => {
    const storedLocale = window.localStorage.getItem(workspaceLocalStorageKey('flujo-avatar:locale'));
    const storedAvatar = window.localStorage.getItem(workspaceLocalStorageKey('flujo-avatar:style'));
    if (['es', 'pt', 'en'].includes(storedLocale ?? '')) setLocale(storedLocale as WorldLocale);
    if (['moss', 'orbit', 'spark'].includes(storedAvatar ?? '')) setAvatar(storedAvatar as AvatarStyle);
    void reload();
    const interval = setInterval(() => { if (document.visibilityState === 'visible') void reload(); }, 15_000);
    return () => clearInterval(interval);
  }, [reload]);
  const pageContext = async (): Promise<AskFlujoPageContext> => await panel.context() ?? {
    scopeId: `world:${getSelectedWorkspace()}`, pageType: 'generic', route: '/world', title: 'Flujo world',
    data: { locale, avatarStyle: avatar, selectedPlace: place, world: snapshot },
    capabilities: { notes: ['The world is a passive projection of Flujo entities. Setup secrets are excluded. Open a real Flujo panel for precise edits.'] },
  };
  const work = useAvatarWork({ modelId: snapshot?.workModel?.ready ? snapshot.workModel.modelId : null, locale, context: pageContext });
  const ready = Boolean(snapshot?.workModel?.ready);
  useEffect(() => { if (work.messages.length) transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }, [work.messages]);
  useEffect(() => { if (!work.busy) void reload(); }, [work.busy, reload]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setSetup(false); setPlace(null); panel.close(); input.current?.focus(); } };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  });
  const send = async () => {
    const text = draft.trim(); if (!text) return;
    if (!ready) { setSetup(true); return; }
    setDraft(''); await work.send(text);
  };
  const objects = snapshot?.objects.filter(object => object.kind === (place ? PLACE_KINDS[place] : null)) ?? [];
  const labels: Record<WorldPlace, string> = { models: c.springs, apps: c.harbor, flows: c.workshop, personas: c.residents, automations: c.routines, meetings: c.gathering, packages: c.market, archive: c.archive, settings: c.control };
  return <div className={styles.world} data-avatar={avatar} data-phase={work.phase} data-evolved={ready}>
    <div className={styles.grain} aria-hidden="true" />
    <header className={styles.topbar}>
      <Link href="/" className={styles.wordmark} aria-label="Flujo">flujo<span>◌</span></Link>
      <div className={styles.topActions}>
        {snapshot?.workModel && <button className={styles.brain} onClick={() => setSetup(true)} disabled={work.busy}><span>◈</span>{snapshot.workModel.label}<span>↗</span></button>}
        <select aria-label="Language / Idioma" value={locale} onChange={event => { const value = event.target.value as WorldLocale; setLocale(value); window.localStorage.setItem(workspaceLocalStorageKey('flujo-avatar:locale'), value); }}><option value="es">ES</option><option value="pt">PT</option><option value="en">EN</option></select>
        <button onClick={() => setExploring(value => !value)} className={styles.mapToggle} aria-pressed={exploring} aria-label={c.world}>⌘</button>
      </div>
    </header>
    <div className={`${styles.mapLayer} ${exploring ? styles.mapVisible : ''}`} aria-hidden={!exploring} inert={!exploring}><Watershed snapshot={snapshot} locale={locale} selected={place} onSelect={selected => { setPlace(selected); if (selected === 'models') setSetup(true); }} /></div>
    <section className={`${styles.companion} ${exploring ? styles.companionAside : ''}`}>
      <div className={styles.presence}><span className={styles.presenceDot} />{work.activity || c[work.phase]}</div>
      <Eyes phase={work.phase} avatar={avatar} small={exploring} />
      {!work.messages.length && <div className={styles.welcome}><h1>{ready ? c.ready : c.hello}</h1><p>{snapshot?.workModel && !ready ? c.stale : ready ? c.readyBody : c.guide}</p>
        {!ready && <button className={styles.primary} onClick={() => setSetup(true)}>{c.discover}<span>↗</span></button>}
        {ready && <button className={styles.textButton} onClick={() => setExploring(true)}>{c.world} ↗</button>}
      </div>}
      <div className={styles.stylePicker} role="group" aria-label={c.style}>{(['moss', 'orbit', 'spark'] as AvatarStyle[]).map(style => <button key={style} aria-pressed={avatar === style} onClick={() => { setAvatar(style); window.localStorage.setItem(workspaceLocalStorageKey('flujo-avatar:style'), style); }} title={c[style === 'moss' ? 'quiet' : style === 'orbit' ? 'measured' : 'bright']}>{style === 'moss' ? '··' : style === 'orbit' ? '◉' : '✧'}<span>{style[0].toUpperCase() + style.slice(1)}</span></button>)}</div>
    </section>
    {work.messages.length > 0 && <div className={styles.transcript} ref={transcript} aria-label={c.history}>{work.messages.map(message => <article key={message.id} className={styles.message} data-role={message.role}>
      <small>{message.role === 'user' ? locale === 'es' ? 'Tú' : locale === 'pt' ? 'Você' : 'You' : 'Flujo'}</small><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
      {message.actions?.map(action => <div className={styles.proposal} key={action.id}><p>{action.label || action.evidence || action.type}</p><button onClick={async () => { const result = await panel.apply(message.scopeId || '', action); setActionResults(current => ({ ...current, [action.id]: result.message })); }}>{c.apply}</button>{actionResults[action.id] && <small>{actionResults[action.id]}</small>}</div>)}
    </article>)}</div>}
    <div className={styles.bottomBar}>
      {(error || work.error || snapshot?.unavailable.length) ? <p role="alert" className={styles.error}>{work.error || error || c.unavailable}<button onClick={() => void reload()}>↻</button></p> : null}
      {work.phase === 'waiting' && work.conversation && <button className={styles.attention} onClick={() => panel.navigate(`/chat?conversationId=${encodeURIComponent(work.conversation!.id)}`)}>{c.waiting} ↗</button>}
      <form className={styles.composer} onSubmit={event => { event.preventDefault(); void send(); }}>
        <button type="button" aria-label={c.voice} onClick={() => input.current?.focus()} title={c.voiceOff}>◉</button>
        <textarea ref={input} aria-label={c.draft} placeholder={c.draft} value={draft} rows={1} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} />
        <button type="submit" aria-label={c.send} disabled={!draft.trim()}>↑</button>
      </form>
      <div className={styles.workControls}><span>{getSelectedWorkspace()}</span><div>{work.busy && <button onClick={() => void work.stop().catch(err => setError(String(err)))}>{c.stop}</button>}{work.conversation && <><button onClick={() => panel.navigate(`/chat?conversationId=${encodeURIComponent(work.conversation!.id)}`)}>{c.history}</button><button onClick={work.newChat} disabled={work.busy}>{c.newChat}</button></>}</div></div>
    </div>
    {place && place !== 'models' && exploring && <aside className={styles.placeSheet}><div className={styles.sheetHead}><span className={styles.eyebrow}>{labels[place]}</span><button onClick={() => setPlace(null)} aria-label={c.close}>×</button></div><h2>{labels[place]}</h2>
      {objects.length === 0 && <p>{c.empty}</p>}{objects.map(object => <button key={`${object.kind}:${object.id}`} className={styles.object} onClick={() => panel.navigate(object.href)}><span>◈</span><div><strong>{object.name}</strong><small>{object.state}</small></div><span>↗</span></button>)}
      <button className={styles.primary} onClick={() => panel.navigate(PLACE_ROUTES[place])}>{c.viewAll} ↗</button>
    </aside>}
    {panel.src && <section className={styles.panel} data-open={panel.open} aria-label={c.inspect} aria-hidden={!panel.open} inert={!panel.open}>
      <div className={styles.panelHead}><span>FLUJO</span><button onClick={() => { panel.close(); void reload(); input.current?.focus(); }} aria-label={c.close}>×</button></div>
      <iframe ref={panel.iframeRef} src={panel.src} data-flujo-avatar-panel="true" title={c.inspect} />
    </section>}
    {setup && <div className={styles.scrim}><ConnectionSetup locale={locale} onClose={() => setSetup(false)} onVerified={async () => { work.newChat(); await reload(); setExploring(true); }} onOther={() => { setSetup(false); panel.navigate('/models'); }} /></div>}
  </div>;
}
