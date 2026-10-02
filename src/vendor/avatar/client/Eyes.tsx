'use client';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import styles from './eyes.module.css';

export type AvatarStyle = 'moss' | 'orbit' | 'spark';
export type EyePhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'usingApp' | 'waiting' | 'error';

export default function Eyes({ phase, avatar, small = false }: { phase: EyePhase; avatar: AvatarStyle; small?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  useEffect(() => {
    let frame = 0;
    const move = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = ref.current?.getBoundingClientRect();
        if (rect) setGaze({ x: Math.max(-9, Math.min(9, (event.clientX - rect.x - rect.width / 2) / 55)), y: Math.max(-5, Math.min(5, (event.clientY - rect.y - rect.height / 2) / 70)) });
      });
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => { window.removeEventListener('pointermove', move); cancelAnimationFrame(frame); };
  }, []);
  return <div ref={ref} className={`${styles.eyes} ${small ? styles.smallEyes : ''}`} data-phase={phase} data-avatar={avatar} aria-hidden="true"
    style={{ '--gaze-x': `${gaze.x}px`, '--gaze-y': `${gaze.y}px` } as CSSProperties}>
    <span className={styles.eye}><i /></span><span className={styles.eye}><i /></span>
    <span className={styles.eyeHalo} />
  </div>;
}
