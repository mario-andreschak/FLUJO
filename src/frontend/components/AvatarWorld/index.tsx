'use client';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AvatarWorldObject, AvatarWorldSnapshot } from '@/shared/types/avatar';
import type { AskFlujoPageContext } from '@/frontend/types/askFlujo';
import { getSelectedWorkspace, workspaceLocalStorageKey } from '@/frontend/utils/workspaceSelection';
import { useI18n } from '@/frontend/contexts/I18nContext';
import Eyes, { type AvatarStyle } from './Eyes';
import { worldCopy, type WorldLocale } from './copy';
import Watershed, { PLACE_ROUTES, PLACE_KINDS, LANDMARK_POSITIONS, type WorldPlace } from './Watershed';
import ConnectionSetup from './ConnectionSetup';
import { useAvatarWork } from './useAvatarWork';
import { useWorldPanel } from './useWorldPanel';
import { useNativeRouterVoice, voiceHeaders, type NativeVoiceTransport } from '@/vendor/avatar/client/useNativeRouterVoice';
import { DEFAULT_LOCALE } from '@/vendor/avatar/client/locale';
import { usePocketSpeech } from '@/vendor/avatar/client/usePocketSpeech';
import ResourcePreview from './ResourcePreview';
import QuickActionsMenu from '@/frontend/components/Navigation/QuickActionsMenu';
import WorldLink from './WorldLink';
import WorldScene from './WorldScene';
import styles from './world.module.css';

export default function AvatarWorld({ voiceTransport }: { voiceTransport?: NativeVoiceTransport } = {}) {
  const [locale, setLocale] = useState<WorldLocale>(DEFAULT_LOCALE);
  const [avatar, setAvatar] = useState<AvatarStyle>('moss');
  const [snapshot, setSnapshot] = useState<AvatarWorldSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  const [exploring, setExploring] = useState(false);
  const [controls, setControls] = useState(false);
  const [details, setDetails] = useState(false);
  const [place, setPlace] = useState<WorldPlace | null>(null);
  const [resource, setResource] = useState<AvatarWorldObject | null>(null);
  const [draft, setDraft] = useState('');
  const [actionResults, setActionResults] = useState<Record<string, string>>({});
  const [voiceMessages, setVoiceMessages] = useState<Array<{ id: string; role: 'user' | 'assistant'; text: string; done: boolean }>>([]);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [pocketAvailable, setPocketAvailable] = useState(false);
  const pocketRequest = useCallback((result: {conversationId:string;messageId:string;locale:string}, signal:AbortSignal) =>
    fetch('/api/avatar/local-speech', {method:'POST',headers:voiceHeaders(),body:JSON.stringify(result),signal,credentials:'same-origin',cache:'no-store',redirect:'error'}), []);
  const pocket = usePocketSpeech(pocketRequest);
  const offered = useRef(new Set<string>());
  const voiceRequest = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const snapshotRequest = useRef(0);
  const c = worldCopy(locale);
  const { setLocale: setFlujoLocale } = useI18n();
  const requestVoice = useCallback((endpoint: Parameters<NativeVoiceTransport['request']>[0], init: RequestInit) =>
    voiceTransport ? voiceTransport.request(endpoint, init) : fetch(endpoint === 'voice' ? '/api/avatar/voice' : `/api/avatar/${endpoint}`, init), [voiceTransport]);
  useEffect(() => { setFlujoLocale(locale); }, [locale, setFlujoLocale]);
  const panel = useWorldPanel(() => input.current?.focus(), locale);
  const reload = useCallback(async () => {
    const generation = ++snapshotRequest.current;
    try {
      const response = await fetch('/api/avatar/world');
      if (!response.ok) throw new Error(`Flujo (${response.status})`);
      const value: AvatarWorldSnapshot = await response.json();
      if (generation === snapshotRequest.current) { setSnapshot(value); setError(null); }
      return value;
    } catch (err) { if (generation === snapshotRequest.current) setError(err instanceof Error ? err.message : 'Flujo unavailable'); }
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
    data: { locale, avatarStyle: avatar, activeIdentity: work.target, selectedPlace: place, world: await reload() ?? snapshot,
      destinations: Object.entries(PLACE_ROUTES).map(([id, href]) => ({ id, href })) },
    capabilities: { notes: ['The world is a passive projection of Flujo entities. Setup secrets are excluded. Open a real Flujo panel for precise edits.'] },
  };
  const work = useAvatarWork({ modelId: snapshot?.workModel?.ready ? snapshot.workModel.modelId : null, locale, context: pageContext });
  const ready = Boolean(snapshot?.workModel?.ready);
  const canWork = ready || work.target.kind !== 'guide' || Boolean(work.conversation);
  const selectedTarget = work.target;
  const actor = selectedTarget.kind === 'guide' ? c.guideIdentity : snapshot?.objects.find(object => object.kind === selectedTarget.kind && object.id === selectedTarget.id)?.name || selectedTarget.name;
  const voice = useNativeRouterVoice({ avatar, locale, transport: voiceTransport, backgroundAsr: true, workInput: canWork, observerPaused: setup || panel.open,
    onUserUtterance: () => { voiceRequest.current++; },
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
  useEffect(() => {
    const controller = new AbortController();
    setVoiceAvailable(false); offered.current.clear(); voiceRequest.current++;
    setVoiceMessages([]);
    void requestVoice('voice', { method: 'GET', signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(status => { if (!controller.signal.aborted) setVoiceAvailable(Boolean(status?.available)); })
      .catch(() => {});
    if(!voiceTransport)void fetch('/api/avatar/local-speech',{signal:controller.signal,credentials:'same-origin',cache:'no-store',redirect:'error'})
      .then(response=>response.ok?response.json():null).then(status=>{if(!controller.signal.aborted)setPocketAvailable(status?.available===true);}).catch(()=>{});
    return () => controller.abort();
  }, [requestVoice,voiceTransport]);
  useEffect(()=>{pocket.disable();},[locale,work.target.kind,'id' in work.target ? work.target.id : '',pocket.disable]);
  useEffect(()=>{if(setup||panel.open||voice.connected)pocket.disable();},[setup,panel.open,voice.connected,pocket.disable]);
  // Sensitive configuration panels never leave a microphone recording in the background.
  useEffect(() => { if (setup || panel.open) voice.disconnect(); }, [setup, panel.open, voice.disconnect]);
  const phase = pocket.speaking ? 'speaking' : voice.connected && voice.phase === 'speaking' ? voice.phase : work.busy ? work.phase : voice.connected && voice.phase === 'listening' ? voice.phase : work.phase;
  const narrationConversationId = work.conversation?.id;
  const narrationLast = work.messages.at(-1);
  const narrationMessageId = narrationLast?.role === 'assistant' ? narrationLast.id : undefined;
  useEffect(() => {
    if (work.busy || !narrationConversationId || !narrationMessageId) return;
    const key = `${narrationConversationId}:${narrationMessageId}`;
    // Connecting voice enables future results; it never replays an old setup recommendation.
    if (!voice.connected&&!pocket.enabled) { offered.current.add(key); return; }
    if (offered.current.has(key)) return;
    offered.current.add(key);
    if(pocket.enabled){pocket.speak({conversationId:narrationConversationId,messageId:narrationMessageId,locale});return;}
    const owner = voice.getSessionOwner();
    const requestEpoch = voiceRequest.current;
    const controller = new AbortController();
    void requestVoice('native-result-receipt', { method: 'POST', headers: voiceHeaders(), signal: controller.signal, body: JSON.stringify({ conversationId: narrationConversationId, messageId: narrationMessageId, locale }) })
      .then(response => response.ok ? response.json() : null).then(receipt => { if (!controller.signal.aborted && receipt?.taskId && owner && voiceRequest.current === requestEpoch) voice.sendTaskResult(receipt.taskId, owner); }).catch(() => {});
    return () => controller.abort();
  }, [narrationMessageId, work.busy, narrationConversationId, voice.connected, pocket.enabled,pocket.speak,locale, voice.sendTaskResult, voice.getSessionOwner, requestVoice]);
  useEffect(() => { if (work.messages.length) transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }, [work.messages]);
  useEffect(() => { if (!work.busy) void reload(); }, [work.busy, reload]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setSetup(false); setControls(false); setDetails(false); setPlace(null); setResource(null); panel.close(); input.current?.focus(); } };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  });
  const send = async () => {
    const text = draft.trim(); if (!text) return;
    if (!canWork) {
      if (voiceAvailable) { setDraft(''); await voice.connect(false); voice.sendText(text); }
      else setSetup(true);
      return;
    }
    voiceRequest.current++;
    pocket.stop();
    voice.interrupt(false);
    setVoiceMessages([]);
    setDraft('');
    if (!await work.send(text)) setDraft(current => current || text);
  };
  const objects = snapshot?.objects.filter(object => object.kind === (place ? PLACE_KINDS[place] : null)) ?? [];
  const lastReply = work.messages.filter(message => message.role === 'assistant').at(-1);
  const spoken = voice.connected && voiceMessages.at(-1)?.role === 'assistant' ? voiceMessages.at(-1)?.text : '';
  const caption = spoken || lastReply?.text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[#*`]/g, '').trim();
  const labels: Record<WorldPlace, string> = { models: c.springs, apps: c.harbor, flows: c.workshop, personas: c.residents, automations: c.routines, meetings: c.gathering, packages: c.market, archive: c.archive, settings: c.control };
  return <div className={styles.world} data-avatar={avatar} data-phase={phase} data-evolved={ready} data-conversation={Boolean(work.messages.length)} data-exploring={exploring} data-details={details}>
    <WorldScene snapshot={snapshot} phase={phase} level={voice.audioLevel} exploring={exploring} />
    <div className={styles.grain} aria-hidden="true" />
    <header className={styles.topbar}>
      <Link href="/" className={styles.wordmark} aria-label="Flujo">flujo<span>◌</span></Link>
      <div className={styles.topActions}>
        <button onClick={() => { setExploring(value => !value); setControls(false); setDetails(false); }} className={styles.mapToggle} aria-pressed={exploring} aria-label={c.world}>{exploring ? '×' : '◌'}<span>{c.world}</span></button>
        <button className={styles.menuToggle} aria-label={c.controls} aria-expanded={controls} onClick={() => setControls(value => !value)}>···</button>
      </div>
    </header>
    {controls && <aside className={styles.controls} aria-label={c.controls}>
      {work.target.kind !== 'guide' ? <button className={styles.identity} disabled={work.busy} onClick={() => { if (work.newChat({ kind: 'guide' })) { voice.disconnect(); setVoiceMessages([]); offered.current.clear(); setControls(false); } }}>{actor} · ↩ {c.guideIdentity}</button> : <button className={styles.brain} onClick={() => { setControls(false); setSetup(true); }} disabled={work.busy}>{snapshot?.workModel?.label || c.discover} ↗</button>}
      <label>{c.language}<select aria-label="Language / Idioma" value={locale} onChange={event => { const value = event.target.value as WorldLocale; setLocale(value); window.localStorage.setItem(workspaceLocalStorageKey('flujo-avatar:locale'), value); }}><option value="en">EN</option><option value="es">ES</option><option value="pt">PT</option></select></label>
      <div className={styles.stylePicker} role="group" aria-label={c.style}>{(['moss', 'orbit', 'spark'] as AvatarStyle[]).map(style => <button key={style} aria-pressed={avatar === style} onClick={() => { setAvatar(style); window.localStorage.setItem(workspaceLocalStorageKey('flujo-avatar:style'), style); }} title={c[style === 'moss' ? 'quiet' : style === 'orbit' ? 'measured' : 'bright']}>{style === 'moss' ? '··' : style === 'orbit' ? '◉' : '✧'}<span>{style[0].toUpperCase() + style.slice(1)}</span></button>)}</div>
      {voiceAvailable && !voice.connected && <button onClick={() => { setControls(false); void voice.connect(false); }} disabled={voice.connecting}>{c.voiceOutput}</button>}
      {pocketAvailable&&<button aria-pressed={pocket.enabled} onClick={()=>{voice.disconnect();if(pocket.enabled)pocket.disable();else pocket.enable();setControls(false);}}>{locale==='es'?'Voz local':locale==='pt'?'Voz local':'Local speech'}</button>}
      {work.conversation && <><button onClick={() => { setControls(false); panel.navigate(`/chat?conversation=${encodeURIComponent(work.conversation!.id)}`); }}>{c.inspect} ↗</button><button onClick={() => { voice.disconnect(); pocket.disable(); offered.current.clear(); setVoiceMessages([]); work.newChat(); setControls(false); }} disabled={work.busy}>{c.newChat}</button></>}
    </aside>}
    <div className={`${styles.mapLayer} ${exploring ? styles.mapVisible : ''}`} aria-hidden={details || setup || panel.open} inert={details || setup || panel.open}><Watershed snapshot={snapshot} locale={locale} selected={place} onSelect={selected => { setExploring(true); setPlace(selected); if (selected === 'models') setSetup(true); }} /></div>
    <section className={`${styles.companion} ${exploring ? styles.companionAside : ''}`} style={exploring && place ? { left: `${LANDMARK_POSITIONS[place][0]}%`, '--arrival-y': `${LANDMARK_POSITIONS[place][1] - 22}%` } as CSSProperties : undefined}>
      <div className={styles.presence}><span className={styles.presenceDot} />{c[phase]}</div>
      <div className={styles.character}><Eyes phase={phase} avatar={avatar} level={voice.audioLevel} small={exploring} /><div className={styles.characterShadow} /></div>
      {!work.messages.length && <div className={styles.welcome}><h1>{work.target.kind !== 'guide' ? actor : canWork ? c.ready : c.hello}</h1><p aria-live="polite">{voiceMessages.at(-1)?.text || (work.target.kind !== 'guide' ? c.identityNote : snapshot?.workModel && !ready ? c.stale : canWork ? c.readyBody : c.guide)}</p>
        {!canWork && <button className={styles.primary} onClick={() => setSetup(true)}>{c.discover}<span>↗</span></button>}
        {canWork && <button className={styles.textButton} onClick={() => setExploring(true)}>{c.world} ↗</button>}
      </div>}
      {work.messages.length > 0 && !exploring && <div className={styles.caption}><p aria-live="polite">{work.busy ? c[work.phase] : caption ? caption.length > 190 ? `${caption.slice(0, 187).trim()}…` : caption : ''}</p>{lastReply && <button onClick={() => setDetails(true)}>{c.details} ↗</button>}</div>}
    </section>
    {work.messages.length > 0 && <div className={styles.transcript} data-open={details && !exploring} ref={transcript} aria-label={c.history} aria-hidden={!details || exploring} inert={!details || exploring}><div className={styles.sheetHead}><span>{c.history}</span><button onClick={() => setDetails(false)} aria-label={c.close}>×</button></div>{work.messages.map(message => <article key={message.id} className={styles.message} data-role={message.role}>
      <small>{message.role === 'user' ? locale === 'es' ? 'Tú' : locale === 'pt' ? 'Você' : 'You' : actor}</small><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, title, children }) => <WorldLink href={href} title={title} workspace={getSelectedWorkspace()} onNavigate={panel.navigate} onOpen={voice.disconnect}>{children}</WorldLink> }}>{message.text}</ReactMarkdown>
      {message.actions?.map(action => <div className={styles.proposal} key={action.id}><p>{action.label || action.evidence || action.type}</p><button onClick={async () => { const result = await panel.apply(message.scopeId || '', action); setActionResults(current => ({ ...current, [action.id]: result.message })); }}>{c.apply}</button>{actionResults[action.id] && <small>{actionResults[action.id]}</small>}</div>)}
    </article>)}{voice.connected && voiceMessages.at(-1)?.role === 'assistant' && voiceMessages.at(-1)?.text && <article className={styles.message} aria-live="polite"><small>{avatar}</small><p>{voiceMessages.at(-1)?.text}</p></article>}</div>}
    <div className={styles.bottomBar}>
      {(error || work.error || voice.error || pocket.error || snapshot?.unavailable.length) ? <p role="alert" className={styles.error}>{work.error || voice.error || pocket.error || error || c.unavailable}<button onClick={() => { voice.clearError(); setError(null); void reload(); }}>↻</button></p> : null}
      {work.phase === 'waiting' && work.conversation && <button className={styles.attention} onClick={() => panel.navigate(`/chat?conversation=${encodeURIComponent(work.conversation!.id)}`)}>{c.waiting} ↗</button>}
      <form className={styles.composer} onSubmit={event => { event.preventDefault(); void send(); }}>
        <button type="button" aria-label={voice.hasMicrophone ? c.stopSpeech : c.voice} aria-pressed={voice.hasMicrophone} disabled={!voiceAvailable || voice.connecting} onClick={() => voice.hasMicrophone ? voice.disconnect() : void voice.connect(true)} title={voiceAvailable ? c.voice : c.voiceOff}>{voice.hasMicrophone ? '◌' : '◉'}</button>
        <textarea ref={input} aria-label={c.draft} placeholder={c.draft} value={draft} rows={1} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} />
        <button type="submit" aria-label={c.send} disabled={!draft.trim()}>↑</button>
      </form>
      <div className={styles.workControls}><div>{voice.connected && voice.phase === 'speaking' && <button onClick={() => voice.interrupt()}>{c.stopSpeech}</button>}{pocket.speaking&&<button onClick={pocket.stop}>{c.stopSpeech}</button>}{work.busy && <button onClick={() => void work.stop().catch(err => setError(String(err)))}>{c.stop}</button>}</div></div>
    </div>
    {place && place !== 'models' && exploring && <aside className={styles.placeSheet} data-side={LANDMARK_POSITIONS[place][0] > 55 ? 'left' : 'right'}><div className={styles.sheetHead}><span className={styles.eyebrow}>{labels[place]}</span><button onClick={() => setPlace(null)} aria-label={c.close}>×</button></div><h2>{labels[place]}</h2>
      {objects.length === 0 && <p>{c.empty}</p>}{objects.map(object => <div key={`${object.kind}:${object.id}`}><button className={styles.object} onClick={() => object.resource ? setResource(object) : panel.navigate(object.href)}><span>◈</span><div><strong>{object.name}</strong><small>{object.state}</small></div><span>↗</span></button>{(['flow', 'persona'].includes(object.kind) && object.canTalk) && <button className={styles.talkIdentity} disabled={work.busy} onClick={() => { if (work.newChat({ kind: object.kind as 'flow' | 'persona', id: object.id, name: object.name })) { voice.disconnect(); setVoiceMessages([]); offered.current.clear(); setPlace(null); setExploring(false); input.current?.focus(); } }}>{c.talkTo} · {object.name} ↗</button>}</div>)}
      <button className={styles.primary} onClick={() => panel.navigate(PLACE_ROUTES[place])}>{c.viewAll} ↗</button>
      {place === 'apps' && <QuickActionsMenu pathname="/world" variant="drawer" onNavigate={panel.navigate} onAction={voice.disconnect} />}
    </aside>}
    {resource && <ResourcePreview key={resource.id} object={resource} locale={locale} onClose={() => setResource(null)} onConversation={() => { panel.navigate(resource.href); setResource(null); }} />}
    {panel.src && <section className={styles.panel} data-open={panel.open} aria-label={c.inspect} aria-hidden={!panel.open} inert={!panel.open}>
      <div className={styles.panelHead}><span>FLUJO</span><button onClick={() => { panel.close(); void reload(); input.current?.focus(); }} aria-label={c.close}>×</button></div>
      <iframe ref={panel.iframeRef} src={panel.src} data-flujo-avatar-panel="true" title={c.inspect} />
    </section>}
    {setup && <div className={styles.scrim}><ConnectionSetup locale={locale} onClose={() => setSetup(false)} onVerified={async () => { work.newChat(); setVoiceMessages([]); offered.current.clear(); await reload(); setExploring(false); }} onOther={() => { setSetup(false); panel.navigate('/models'); }} /></div>}
  </div>;
}
