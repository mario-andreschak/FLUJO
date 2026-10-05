'use client';
import { useEffect, useState } from 'react';
import Image from 'next/image';
import type { AvatarWorldObject } from '@/shared/types/avatar';
import { getSelectedWorkspace } from '@/frontend/utils/workspaceSelection';
import { worldCopy, type WorldLocale } from './copy';
import styles from './world.module.css';
export default function ResourcePreview({ object, locale, onClose, onConversation }: { object: AvatarWorldObject; locale: WorldLocale; onClose: () => void; onConversation: () => void }) {
  const [text, setText] = useState<string | null>(null), [error, setError] = useState(false);
  const resource = object.resource!, c = worldCopy(locale);
  const url = `/v1/chat/conversations/${encodeURIComponent(resource.conversationId)}/resources/${encodeURIComponent(resource.id)}/content?workspace=${encodeURIComponent(getSelectedWorkspace())}`;
  useEffect(() => {
    if (resource.kind !== 'text') return;
    const controller = new AbortController();
    void fetch(url, { headers: { Range: 'bytes=0-65535' }, signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Unavailable');
      if (!response.body) throw new Error('Unavailable');
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) throw new Error('Unbounded');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      setText(new TextDecoder().decode(bytes));
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [url, resource.kind]);
  return <aside className={styles.resourceSheet} aria-label={object.name}>
    <div className={styles.sheetHead}><span className={styles.eyebrow}>{c.resources}</span><button onClick={onClose} aria-label={c.close}>×</button></div>
    <h2>{object.name}</h2><small>{resource.kind} · {Math.round(resource.size / 1024)} KB · {new Date(resource.createdAt).toLocaleString(locale)}</small>
    {error && <p role="alert">{c.unavailable}</p>}
    {resource.kind === 'text' && <pre>{text ?? c.loading}</pre>}
    {resource.kind === 'image' && /^image\/(png|jpeg|gif|webp|avif)$/.test(resource.mimeType ?? '') && <Image unoptimized src={url} alt={object.name} width={1280} height={960} style={{ width: 'auto', height: 'auto' }} onError={() => setError(true)} />}
    {resource.kind === 'audio' && <audio src={url} controls onError={() => setError(true)} />}
    <div className={styles.resourceActions}><button onClick={onConversation}>{c.history} ↗</button>{resource.kind !== 'link' && <a href={url} download={object.name}>↓ {object.name}</a>}</div>
  </aside>;
}
