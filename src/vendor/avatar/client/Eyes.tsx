'use client';
import { useEffect, useRef, type CSSProperties } from 'react';
import styles from './eyes.module.css';

export type AvatarStyle = 'moss' | 'orbit' | 'spark';
export type EyePhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'usingApp' | 'waiting' | 'error';

export interface EyesProps { phase: EyePhase; avatar: AvatarStyle; small?: boolean; level?: number }
export default function Eyes({ phase, avatar, small = false, level = 0 }: EyesProps) {
  const ref = useRef<HTMLDivElement>(null);
  const state = useRef(phase); state.current = phase;
  useEffect(() => {
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, lastPointer = 0, x = 0, y = 0;
    const target = { x: 0, y: 0 };
    const move = (event: PointerEvent) => {
      if (motion.matches) return;
      const rect = ref.current?.getBoundingClientRect();
      if (rect) { target.x = Math.max(-11, Math.min(11, (event.clientX - rect.x - rect.width / 2) / 45)); target.y = Math.max(-7, Math.min(7, (event.clientY - rect.y - rect.height / 2) / 60)); lastPointer = performance.now(); }
    };
    const tick = (now: number) => {
      if (motion.matches || document.hidden) { frame = 0; return; }
      const resting = now - lastPointer > 2500;
      const working = state.current === 'thinking' || state.current === 'usingApp';
      x += ((resting ? working ? 6 + Math.sin(now / 1700) * 2 : Math.sin(now / 3700) * 2.5 : target.x) - x) * .09;
      y += ((resting ? working ? -3 : Math.cos(now / 4200) * 1.2 : target.y) - y) * .09;
      ref.current?.style.setProperty('--gaze-x', `${x.toFixed(2)}px`); ref.current?.style.setProperty('--gaze-y', `${y.toFixed(2)}px`);
      ref.current?.style.setProperty('--head-tilt', `${(x * -.14).toFixed(2)}deg`);
      frame = requestAnimationFrame(tick);
    };
    const resume = () => { cancelAnimationFrame(frame); if (!motion.matches && !document.hidden) frame = requestAnimationFrame(tick); };
    window.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('visibilitychange', resume); motion.addEventListener('change', resume); resume();
    return () => { window.removeEventListener('pointermove', move); document.removeEventListener('visibilitychange', resume); motion.removeEventListener('change', resume); cancelAnimationFrame(frame); };
  }, []);
  return <div ref={ref} className={`${styles.eyes} ${small ? styles.smallEyes : ''}`} data-phase={phase} data-avatar={avatar} aria-hidden="true"
    style={{ '--voice-level': Math.max(0, Math.min(1, level)), '--gaze-x': '0px', '--gaze-y': '0px' } as CSSProperties}>
    <span className={styles.eye}><i /></span><span className={styles.eye}><i /></span>
    <span className={styles.eyeHalo} />
  </div>;
}
