'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AvatarWorldObject, AvatarWorldSnapshot } from '@/shared/types/avatar';
import type { AskFlujoPageContext } from '@/frontend/types/askFlujo';
import { getSelectedWorkspace, workspaceLocalStorageKey } from '@/frontend/utils/workspaceSelection';
import { useI18n } from '@/frontend/contexts/I18nContext';
import Eyes, { type AvatarStyle } from './Eyes';
import { worldCopy, type WorldLocale } from './copy';
import Watershed, { PLACE_ROUTES, PLACE_KINDS, type WorldPlace } from './Watershed';
import ConnectionSetup from './ConnectionSetup';
import { useAvatarWork } from './useAvatarWork';
import { useWorldPanel } from './useWorldPanel';
import { useNativeRouterVoice, voiceHeaders } from '@/vendor/avatar/client/useNativeRouterVoice';
import ResourcePreview from './ResourcePreview';
import styles from './world.module.css';

export default function AvatarWorld() {
  const [locale, setLocale] = useState<WorldLocale>('es');
  const [avatar, setAvatar] = useState<AvatarStyle>('moss');
  const [snapshot, setSnapshot] = useState<AvatarWorldSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  const [exploring, setExploring] = useState(false);
  const [place, setPlace] = useState<WorldPlace | null>(null);
  const [resource, setResource] = useState<AvatarWorldObject | null>(null);
  const [draft, setDraft] = useState('');
  const [actionResults, setActionResults] = useState<Record<string, string>>({});
  const [voiceMessages, setVoiceMessages] = useState<Array<{ id: string; role: 'user' | 'assistant'; text: string; done: boolean }>>([]);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const offered = useRef(new Set<string>());
  const input = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const c = worldCopy(locale);
  const { setLocale: setFlujoLocale } = useI18n();
  useEffect(() => { setFlujoLocale(locale); }, [locale, setFlujoLocale]);
  const panel = useWorldPanel(() => input.current?.focus(), locale);
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
    data: { locale, avatarStyle: avatar, activeIdentity: work.target, selectedPlace: place, world: snapshot },
    capabilities: { notes: ['The world is a passive projection of Flujo entities. Setup secrets are excluded. Open a real Flujo panel for precise edits.'] },
  };
  const work = useAvatarWork({ modelId: snapshot?.workModel?.ready ? snapshot.workModel.modelId : null, locale, context: pageContext });
  const ready = Boolean(snapshot?.workModel?.ready);
  const canWork = ready || work.target.kind !== 'guide' || Boolean(work.conversation);
  const selectedTarget = work.target;
  const actor = selectedTarget.kind === 'guide' ? c.guideIdentity : snapshot?.objects.find(object => object.kind === selectedTarget.kind && object.id === selectedTarget.id)?.name || selectedTarget.name;
  const voice = useNativeRouterVoice({ avatar, locale, backgroundAsr: true, observerPaused: setup || panel.open,
    onTranscript: (id, role, text, done) => setVoiceMessages(current => {
      const item = { id, role, text, done }, index = current.findIndex(message => message.id === id);
      return index < 0 ? [...current.slice(-39), item] : current.map(message => message.id === id ? item : message);
    }),
    onObservedTranscript: (id, text) => {
      setVoiceMessages(current => [...current.slice(-39), { id, role: 'user', text, done: true }]);
      if (canWork) void work.send(text);
    },
    onObserverError: () => setError(locale === 'pt' ? 'Não reconheci o pedido. Você pode escrever.' : locale === 'es' ? 'No reconocí la petición. Puedes escribir.' : 'The request was not recognized. You can type.'),
    onInterrupted: () => setVoiceMessages(current => current.map(message => message.done ? message : { ...message, text: '', done: true })),
  });
  useEffect(() => { void fetch('/api/avatar/voice').then(response => response.ok ? response.json() : null).then(status => setVoiceAvailable(Boolean(status?.available))).catch(() => {}); }, []);
  // Sensitive configuration panels never leave a microphone recording in the background.
  useEffect(() => { if (setup || panel.open) voice.disconnect(); }, [setup, panel.open, voice.disconnect]);
  const phase = voice.connected && ['speaking', 'listening'].includes(voice.phase) ? voice.phase : work.phase;
  useEffect(() => {
    const last = work.messages.at(-1), conversation = work.conversation;
    if (!voice.connected || work.busy || !conversation || last?.role !== 'assistant') return;
    const key = `${conversation.id}:${last.id}`;
    if (offered.current.has(key)) return;
    offered.current.add(key);
    const owner = voice.getSessionOwner();
    void fetch('/api/avatar/native-result-receipt', { method: 'POST', headers: voiceHeaders(), body: JSON.stringify({ conversationId: conversation.id, messageId: last.id, locale }) })
      .then(response => response.ok ? response.json() : null).then(receipt => { if (receipt?.taskId && owner) voice.sendTaskResult(receipt.taskId, owner); }).catch(() => {});
  }, [work.messages, work.busy, work.conversation, voice.connected, locale, voice.sendTaskResult, voice.getSessionOwner]);
  useEffect(() => { if (work.messages.length) transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }, [work.messages]);
  useEffect(() => { if (!work.busy) void reload(); }, [work.busy, reload]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setSetup(false); setPlace(null); setResource(null); panel.close(); input.current?.focus(); } };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  });
  const send = async () => {
    const text = draft.trim(); if (!text) return;
    if (!canWork) {
      if (voiceAvailable) { setDraft(''); await voice.connect(false); voice.sendText(text); }
      else setSetup(true);
      return;
    }
    setDraft(''); await work.send(text);
  };
  const objects = snapshot?.objects.filter(object => object.kind === (place ? PLACE_KINDS[place] : null)) ?? [];
  const labels: Record<WorldPlace, string> = { models: c.springs, apps: c.harbor, flows: c.workshop, personas: c.residents, automations: c.routines, meetings: c.gathering, packages: c.market, archive: c.archive, settings: c.control };
  return <div className={styles.world} data-avatar={avatar} data-phase={phase} data-evolved={ready} data-conversation={Boolean(work.messages.length)} data-exploring={exploring}>
    <div className={styles.grain} aria-hidden="true" />
    <header className={styles.topbar}>
      <Link href="/" className={styles.wordmark} aria-label="Flujo">flujo<span>◌</span></Link>
      <div className={styles.topActions}>
        {work.target.kind !== 'guide' && <button className={styles.identity} title={c.guideIdentity} disabled={work.busy} onClick={() => { if (work.newChat({ kind: 'guide' })) { voice.disconnect(); setVoiceMessages([]); offered.current.clear(); } }}>{actor} · ↩ {c.guideIdentity}</button>}
        {snapshot?.workModel && <button className={styles.brain} onClick={() => setSetup(true)} disabled={work.busy}><span>◈</span>{snapshot.workModel.label}<span>↗</span></button>}
        <select aria-label="Language / Idioma" value={locale} onChange={event => { const value = event.target.value as WorldLocale; setLocale(value); window.localStorage.setItem(workspaceLocalStorageKey('flujo-avatar:locale'), value); }}><option value="es">ES</option><option value="pt">PT</option><option value="en">EN</option></select>
        <button onClick={() => setExploring(value => !value)} className={styles.mapToggle} aria-pressed={exploring} aria-label={c.world}>⌘</button>
      </div>
    </header>
    <div className={`${styles.mapLayer} ${exploring ? styles.mapVisible : ''}`} aria-hidden={!exploring} inert={!exploring}><Watershed snapshot={snapshot} locale={locale} selected={place} onSelect={selected => { setPlace(selected); if (selected === 'models') setSetup(true); }} /></div>
    <section className={`${styles.companion} ${exploring ? styles.companionAside : ''}`}>
      <div className={styles.presence}><span className={styles.presenceDot} />{work.activity || c[phase]}</div>
      <Eyes phase={phase} avatar={avatar} small={exploring} />
      {!work.messages.length && <div className={styles.welcome}><h1>{work.target.kind !== 'guide' ? actor : canWork ? c.ready : c.hello}</h1><p aria-live="polite">{voiceMessages.at(-1)?.text || (work.target.kind !== 'guide' ? c.identityNote : snapshot?.workModel && !ready ? c.stale : canWork ? c.readyBody : c.guide)}</p>
        {!canWork && <button className={styles.primary} onClick={() => setSetup(true)}>{c.discover}<span>↗</span></button>}
        {canWork && <button className={styles.textButton} onClick={() => setExploring(true)}>{c.world} ↗</button>}
      </div>}
      <div className={styles.stylePicker} role="group" aria-label={c.style}>{(['moss', 'orbit', 'spark'] as AvatarStyle[]).map(style => <button key={style} aria-pressed={avatar === style} onClick={() => { setAvatar(style); window.localStorage.setItem(workspaceLocalStorageKey('flujo-avatar:style'), style); }} title={c[style === 'moss' ? 'quiet' : style === 'orbit' ? 'measured' : 'bright']}>{style === 'moss' ? '··' : style === 'orbit' ? '◉' : '✧'}<span>{style[0].toUpperCase() + style.slice(1)}</span></button>)}</div>
    </section>
    {work.messages.length > 0 && <div className={styles.transcript} ref={transcript} aria-label={c.history} aria-hidden={exploring} inert={exploring}>{work.messages.map(message => <article key={message.id} className={styles.message} data-role={message.role}>
      <small>{message.role === 'user' ? locale === 'es' ? 'Tú' : locale === 'pt' ? 'Você' : 'You' : actor}</small><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
      {message.actions?.map(action => <div className={styles.proposal} key={action.id}><p>{action.label || action.evidence || action.type}</p><button onClick={async () => { const result = await panel.apply(message.scopeId || '', action); setActionResults(current => ({ ...current, [action.id]: result.message })); }}>{c.apply}</button>{actionResults[action.id] && <small>{actionResults[action.id]}</small>}</div>)}
    </article>)}{voice.connected && voiceMessages.at(-1)?.role === 'assistant' && voiceMessages.at(-1)?.text && <article className={styles.message} aria-live="polite"><small>{avatar}</small><p>{voiceMessages.at(-1)?.text}</p></article>}</div>}
    <div className={styles.bottomBar}>
      {(error || work.error || voice.error || snapshot?.unavailable.length) ? <p role="alert" className={styles.error}>{work.error || voice.error || error || c.unavailable}<button onClick={() => { voice.clearError(); setError(null); void reload(); }}>↻</button></p> : null}
      {work.phase === 'waiting' && work.conversation && <button className={styles.attention} onClick={() => panel.navigate(`/chat?conversation=${encodeURIComponent(work.conversation!.id)}`)}>{c.waiting} ↗</button>}
      <form className={styles.composer} onSubmit={event => { event.preventDefault(); void send(); }}>
        <button type="button" aria-label={voice.hasMicrophone ? c.stopSpeech : c.voice} aria-pressed={voice.hasMicrophone} disabled={!voiceAvailable || voice.connecting} onClick={() => voice.hasMicrophone ? voice.disconnect() : void voice.connect(true)} title={voiceAvailable ? c.voice : c.voiceOff}>{voice.hasMicrophone ? '◌' : '◉'}</button>
        <textarea ref={input} aria-label={c.draft} placeholder={c.draft} value={draft} rows={1} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} />
        <button type="submit" aria-label={c.send} disabled={!draft.trim()}>↑</button>
      </form>
      <div className={styles.workControls}><span>{getSelectedWorkspace()}</span><div>{voiceAvailable && !voice.connected && <button onClick={() => void voice.connect(false)} disabled={voice.connecting}>{c.voiceOutput}</button>}{voice.connected && <button onClick={voice.interrupt}>{c.stopSpeech}</button>}{work.busy && <button onClick={() => void work.stop().catch(err => setError(String(err)))}>{c.stop}</button>}{work.conversation && <><button onClick={() => panel.navigate(`/chat?conversation=${encodeURIComponent(work.conversation!.id)}`)}>{c.history}</button><button onClick={() => { voice.disconnect(); offered.current.clear(); setVoiceMessages([]); work.newChat(); }} disabled={work.busy}>{c.newChat}</button></>}</div></div>
    </div>
    {place && place !== 'models' && exploring && <aside className={styles.placeSheet}><div className={styles.sheetHead}><span className={styles.eyebrow}>{labels[place]}</span><button onClick={() => setPlace(null)} aria-label={c.close}>×</button></div><h2>{labels[place]}</h2>
      {objects.length === 0 && <p>{c.empty}</p>}{objects.map(object => <div key={`${object.kind}:${object.id}`}><button className={styles.object} onClick={() => object.resource ? setResource(object) : panel.navigate(object.href)}><span>◈</span><div><strong>{object.name}</strong><small>{object.state}</small></div><span>↗</span></button>{(['flow', 'persona'].includes(object.kind) && object.canTalk) && <button className={styles.talkIdentity} disabled={work.busy} onClick={() => { if (work.newChat({ kind: object.kind as 'flow' | 'persona', id: object.id, name: object.name })) { voice.disconnect(); setVoiceMessages([]); offered.current.clear(); setPlace(null); setExploring(false); input.current?.focus(); } }}>{c.talkTo} · {object.name} ↗</button>}</div>)}
      <button className={styles.primary} onClick={() => panel.navigate(PLACE_ROUTES[place])}>{c.viewAll} ↗</button>
    </aside>}
    {resource && <ResourcePreview key={resource.id} object={resource} locale={locale} onClose={() => setResource(null)} onConversation={() => { panel.navigate(resource.href); setResource(null); }} />}
    {panel.src && <section className={styles.panel} data-open={panel.open} aria-label={c.inspect} aria-hidden={!panel.open} inert={!panel.open}>
      <div className={styles.panelHead}><span>FLUJO</span><button onClick={() => { panel.close(); void reload(); input.current?.focus(); }} aria-label={c.close}>×</button></div>
      <iframe ref={panel.iframeRef} src={panel.src} data-flujo-avatar-panel="true" title={c.inspect} />
    </section>}
    {setup && <div className={styles.scrim}><ConnectionSetup locale={locale} onClose={() => setSetup(false)} onVerified={async () => { work.newChat(); setVoiceMessages([]); offered.current.clear(); await reload(); setExploring(true); }} onOther={() => { setSetup(false); panel.navigate('/models'); }} /></div>}
  </div>;
}
