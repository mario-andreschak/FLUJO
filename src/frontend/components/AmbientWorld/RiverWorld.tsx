"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

import { useTheme } from '@/frontend/contexts/ThemeContext';

import {
  cameraForScene,
  canvasPixelRatioForViewport,
  renderRiverWorld,
  type RiverCamera,
  type RiverPointer,
} from './riverRenderer';
import { RIVER_SCENES, resolveRiverScene, type RiverScene } from './sceneMap';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n/messages';

interface CameraFlight {
  from: RiverCamera;
  to: RiverCamera;
  startedAt: number;
  duration: number;
}
const WORLD_SCENES = Object.values(RIVER_SCENES) as RiverScene[];
const STILL_POINTER: RiverPointer = { x: 0, y: 0 };
const FLIGHT_FRAME_INTERVAL_MS = 16;
const AMBIENT_FRAME_INTERVAL_MS = 100;

const clamp = (value: number, minimum: number, maximum: number) => (
  Math.min(maximum, Math.max(minimum, value))
);

const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;

const easeInOutQuint = (value: number) => (
  value < 0.5
    ? 16 * value * value * value * value * value
    : 1 - Math.pow(-2 * value + 2, 5) / 2
);

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
export default function RiverWorld() {
  const { t } = useI18n();
  const pathname = usePathname();
  const { isDarkMode, livingWorldEnabled, themeHydrated, visualStyle } = useTheme();
  const scene = useMemo(() => resolveRiverScene(pathname), [pathname]);
  const sceneLabel = t(`ambient.scene.${scene.id}` as TranslationKey);
  const sceneEyebrow = scene.id === 'home'
    ? t('ambient.eyebrow.home')
    : scene.id === 'models'
      ? t('nav.aiSetup')
      : scene.id === 'mcp'
        ? t('nav.connectedApps')
        : scene.id === 'flows'
          ? t('ambient.eyebrow.flows')
          : scene.id === 'chat'
            ? t('nav.talk')
            : scene.id === 'automations'
              ? t('nav.automations')
              : scene.id === 'waves'
                ? t('ambient.eyebrow.waves')
                : scene.id === 'packages'
                  ? t('nav.extensions')
                  : scene.id === 'statistics'
                    ? t('nav.activity')
                    : scene.id === 'docs'
                      ? t('ambient.eyebrow.docs')
                      : t('ambient.eyebrow.settings');
  const enabled = (
    themeHydrated
    && livingWorldEnabled
    && visualStyle === 'modern'
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef(scene);
  const darkRef = useRef(isDarkMode);
  const cameraRef = useRef<RiverCamera>(cameraForScene(scene));
  const flightRef = useRef<CameraFlight | null>(null);
  const pointerRef = useRef<RiverPointer>({ ...STILL_POINTER });
  const pointerTargetRef = useRef<RiverPointer>({ ...STILL_POINTER });
  const requestDrawRef = useRef<(() => void) | null>(null);
  const travelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [travelling, setTravelling] = useState(false);

  useEffect(() => {
    darkRef.current = isDarkMode;
    requestDrawRef.current?.();
  }, [isDarkMode]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('living-world-active', enabled);

    if (enabled) {
      root.dataset.livingScene = scene.id;
      root.style.setProperty('--river-scene-accent', scene.accent);
    } else {
      delete root.dataset.livingScene;
      root.style.removeProperty('--river-scene-accent');
    }

    return () => {
      root.classList.remove('living-world-active');
      delete root.dataset.livingScene;
      root.style.removeProperty('--river-scene-accent');
    };
  }, [enabled, scene.accent, scene.id]);

  useEffect(() => {
    const previousScene = sceneRef.current;
    sceneRef.current = scene;
    const destination = cameraForScene(scene);

    if (!enabled || previousScene.id === scene.id || prefersReducedMotion()) {
      cameraRef.current = destination;
      flightRef.current = null;
      setTravelling(false);
      requestDrawRef.current?.();
      return;
    }

    const distance = Math.abs(destination.x - cameraRef.current.x);
    const duration = clamp(720 + distance * 0.05, 780, 1320);
    flightRef.current = {
      from: { ...cameraRef.current },
      to: destination,
      startedAt: performance.now(),
      duration,
    };
    setTravelling(true);
    if (travelTimerRef.current) clearTimeout(travelTimerRef.current);
    travelTimerRef.current = setTimeout(() => setTravelling(false), duration + 80);
    requestDrawRef.current?.();
  }, [enabled, scene]);

  useEffect(() => () => {
    if (travelTimerRef.current) clearTimeout(travelTimerRef.current);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas || /jsdom/i.test(window.navigator.userAgent)) return;

    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext('2d', { alpha: true });
    } catch {
      return;
    }
    if (!context) return;

    let width = 1;
    let height = 1;
    let pixelRatio = 1;
    let animationFrame = 0;
    let lastPaint = 0;
    let reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const finePointerQuery = window.matchMedia('(hover: hover) and (pointer: fine)');

    const resize = () => {
      width = Math.max(1, window.innerWidth);
      height = Math.max(1, window.innerHeight);
      pixelRatio = canvasPixelRatioForViewport(width, height, window.devicePixelRatio);
      canvas.width = Math.max(1, Math.floor(width * pixelRatio));
      canvas.height = Math.max(1, Math.floor(height * pixelRatio));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context?.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };

    const paint = (now: number) => {
      if (!context) return;
      const flight = flightRef.current;
      if (flight) {
        const progress = clamp((now - flight.startedAt) / flight.duration, 0, 1);
        const eased = easeInOutQuint(progress);
        const pullBack = Math.sin(progress * Math.PI) * 0.085;
        cameraRef.current = {
          x: mix(flight.from.x, flight.to.x, eased),
          y: mix(flight.from.y, flight.to.y, eased),
          zoom: Math.max(0.84, mix(flight.from.zoom, flight.to.zoom, eased) - pullBack),
        };
        if (progress >= 1) {
          cameraRef.current = { ...flight.to };
          flightRef.current = null;
        }
      }

      const pointerEase = flightRef.current ? 0.035 : 0.055;
      pointerRef.current.x = mix(pointerRef.current.x, pointerTargetRef.current.x, pointerEase);
      pointerRef.current.y = mix(pointerRef.current.y, pointerTargetRef.current.y, pointerEase);

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      renderRiverWorld(context, {
        width,
        height,
        time: reducedMotion ? 0 : now,
        dark: darkRef.current,
        camera: cameraRef.current,
        pointer: reducedMotion ? STILL_POINTER : pointerRef.current,
        activeScene: sceneRef.current.id,
        scenes: WORLD_SCENES,
      });
      lastPaint = now;
    };

    const tick = (now: number) => {
      if (document.hidden || reducedMotion) {
        animationFrame = 0;
        return;
      }
      // Camera travel stays fluid, while the decorative idle scene is capped
      // at 10 fps. Painting a full-window canvas at display refresh speed while
      // the user reads a chat wastes an entire renderer core for imperceptible
      // background motion.
      const minimumFrameTime = flightRef.current
        ? FLIGHT_FRAME_INTERVAL_MS
        : AMBIENT_FRAME_INTERVAL_MS;
      if (now - lastPaint >= minimumFrameTime) paint(now);
      animationFrame = window.requestAnimationFrame(tick);
    };

    const requestDraw = () => {
      if (reducedMotion) {
        cameraRef.current = cameraForScene(sceneRef.current);
        flightRef.current = null;
        paint(performance.now());
        return;
      }
      if (!animationFrame && !document.hidden) {
        animationFrame = window.requestAnimationFrame(tick);
      }
    };

    const handleResize = () => {
      resize();
      requestDraw();
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!finePointerQuery.matches) return;
      pointerTargetRef.current.x = clamp((event.clientX / width - 0.5) * 2, -1, 1);
      pointerTargetRef.current.y = clamp((event.clientY / height - 0.5) * 2, -1, 1);
    };

    const resetPointer = () => {
      pointerTargetRef.current = { ...STILL_POINTER };
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (animationFrame) window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      } else {
        requestDraw();
      }
    };

    const handleMotionChange = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      if (reducedMotion) {
        cameraRef.current = cameraForScene(sceneRef.current);
        flightRef.current = null;
        setTravelling(false);
      }
      requestDraw();
    };

    resize();
    requestDrawRef.current = requestDraw;
    window.addEventListener('resize', handleResize, { passive: true });
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('blur', resetPointer);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    motionQuery.addEventListener('change', handleMotionChange);
    requestDraw();

    return () => {
      requestDrawRef.current = null;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('blur', resetPointer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      motionQuery.removeEventListener('change', handleMotionChange);
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <>
      <div className="living-watershed" aria-hidden="true" data-living-world>
        <canvas ref={canvasRef} className="living-watershed__canvas" />
        <div className="living-watershed__atmosphere" />
        <div className="living-watershed__caustics" />
      </div>
      <aside
        className={`living-watershed__location${travelling ? ' is-travelling' : ''}`}
        aria-hidden="true"
      >
        <span className="living-watershed__location-orbit" aria-hidden="true">
          <span />
        </span>
        <span className="living-watershed__location-copy" key={scene.id}>
          <span>{sceneEyebrow}</span>
          <strong>{travelling ? t('ambient.following') : sceneLabel}</strong>
        </span>
        <span className="living-watershed__label">{t('ambient.landscape')}</span>
      </aside>
    </>
  );
}
