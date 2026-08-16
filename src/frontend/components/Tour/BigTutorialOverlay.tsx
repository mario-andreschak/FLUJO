"use client";

import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  LinearProgress,
  Paper,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { usePathname, useRouter } from 'next/navigation';
import { useTour } from '@/frontend/contexts/TourContext';
import {
  BIG_TUTORIAL_STEPS,
  BIG_TUTORIAL_STEP_BY_ID,
  resolveBigTutorialTarget,
  resolveBigTutorialText,
  type BigTutorialStep,
} from './bigTutorialSteps';
import { emitBigTutorialEvent } from './bigTutorialEvents';

const SPOTLIGHT_PADDING = 8;
const CARD_WIDTH = 390;
const CARD_GAP = 16;

interface Rect { top: number; left: number; width: number; height: number }

function clampLeft(left: number, transform: string, viewportWidth: number): number {
  const half = CARD_WIDTH / 2;
  if (transform.includes('-50%')) return Math.min(Math.max(left, half + 8), viewportWidth - half - 8);
  if (transform.includes('-100%')) return Math.min(Math.max(left, CARD_WIDTH + 8), viewportWidth - 8);
  return Math.min(Math.max(left, 8), viewportWidth - CARD_WIDTH - 8);
}

function cardPosition(rect: Rect | null, placement: BigTutorialStep['placement']): React.CSSProperties {
  if (!rect || placement === 'center') {
    return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  }
  const vw = typeof window === 'undefined' ? 1024 : window.innerWidth;
  if (placement === 'top') {
    const transform = 'translate(-50%, -100%)';
    return { top: rect.top - CARD_GAP, left: clampLeft(rect.left + rect.width / 2, transform, vw), transform };
  }
  if (placement === 'left') {
    const transform = 'translate(-100%, -50%)';
    return { top: rect.top + rect.height / 2, left: clampLeft(rect.left - CARD_GAP, transform, vw), transform };
  }
  if (placement === 'right') {
    const transform = 'translate(0, -50%)';
    return { top: rect.top + rect.height / 2, left: clampLeft(rect.left + rect.width + CARD_GAP, transform, vw), transform };
  }
  const transform = 'translate(-50%, 0)';
  return { top: rect.top + rect.height + CARD_GAP, left: clampLeft(rect.left + rect.width / 2, transform, vw), transform };
}

function visibleTargets(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(candidate => {
    const rect = candidate.getBoundingClientRect();
    const style = window.getComputedStyle(candidate);
    return rect.width > 0 && rect.height > 0
      && rect.right > 0 && rect.bottom > 0
      && rect.left < window.innerWidth && rect.top < window.innerHeight
      && style.display !== 'none' && style.visibility !== 'hidden';
  });
}

function unionRect(elements: HTMLElement[]): Rect | null {
  if (elements.length === 0) return null;
  const rects = elements.map(element => element.getBoundingClientRect());
  const top = Math.min(...rects.map(rect => rect.top));
  const left = Math.min(...rects.map(rect => rect.left));
  const right = Math.max(...rects.map(rect => rect.right));
  const bottom = Math.max(...rects.map(rect => rect.bottom));
  return { top, left, width: right - left, height: bottom - top };
}

export default function BigTutorialOverlay() {
  const {
    isBigTutorialActive,
    bigTutorialProgress,
    bigTutorialBusy,
    bigTutorialError,
    bigTutorialRunStatus,
    bigTutorialConnectedServer,
    nextBigTutorial,
    backBigTutorial,
    runBigTutorialAction,
    pauseBigTutorial,
    restartBigTutorial,
  } = useTour();
  const pathname = usePathname();
  const router = useRouter();
  const [rect, setRect] = useState<Rect | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const step = isBigTutorialActive ? BIG_TUTORIAL_STEP_BY_ID.get(bigTutorialProgress.stepId) : undefined;
  const target = step ? resolveBigTutorialTarget(step, bigTutorialProgress) : undefined;

  const mainSteps = useMemo(() => BIG_TUTORIAL_STEPS.filter(candidate => !candidate.nested), []);
  const mainIndex = step ? Math.max(0, mainSteps.findIndex(candidate => candidate.id === step.id)) : 0;

  useEffect(() => {
    if (!step) return;
    const destination = step.route?.(bigTutorialProgress) ?? step.path;
    const currentRoute = typeof window === 'undefined' ? pathname : `${pathname}${window.location.search}`;
    const routeChanged = step.route ? currentRoute !== destination : pathname !== step.path;
    if (routeChanged) router.push(destination);
  }, [bigTutorialProgress, pathname, router, step]);

  useEffect(() => {
    if (!step?.onEnter || pathname !== step.path) return;
    const timer = window.setTimeout(() => {
      if (step.onEnter === 'filter-chat-agent') {
        emitBigTutorialEvent({ type: 'filter-agent-search', query: 'Chat' });
      } else if (step.onEnter === 'open-chat-flow-picker') {
        emitBigTutorialEvent({ type: 'open-chat-flow-picker', query: 'Chat' });
      } else if (
        step.onEnter === 'prepare-app-picker'
        && bigTutorialProgress.processNodeId
        && bigTutorialProgress.recommendedServerName
      ) {
        emitBigTutorialEvent({
          type: 'prepare-app-picker',
          processNodeId: bigTutorialProgress.processNodeId,
          query: bigTutorialProgress.recommendedServerName,
        });
      } else if (step.onEnter === 'open-app-marketplace') {
        emitBigTutorialEvent({ type: 'open-app-marketplace' });
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [bigTutorialProgress.recommendedServerName, pathname, step]);

  useLayoutEffect(() => {
    if (!step || pathname !== step.path || !target) {
      setRect(null);
      return;
    }
    let timer = 0;
    let scrolled = false;
    const measure = () => {
      const elements = visibleTargets(target);
      if (elements[0] && !scrolled) {
        elements[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
        scrolled = true;
      }
      setRect(unionRect(elements));
      timer = window.setTimeout(measure, 200);
    };
    measure();
    return () => window.clearTimeout(timer);
  }, [pathname, step, target]);

  useEffect(() => {
    if (!step?.advanceOnTargetClick || pathname !== step.path || !target) return;
    let handled = false;
    const handler = (event: MouseEvent) => {
      if (handled || !(event.target instanceof Element)) return;
      const element = event.target.closest<HTMLElement>(target);
      if (!element || !visibleTargets(target).includes(element)) return;
      handled = true;
      if (element.matches('a[href]')) {
        event.preventDefault();
        event.stopPropagation();
        void nextBigTutorial();
        return;
      }
      window.setTimeout(() => void nextBigTutorial(), 0);
    };
    document.addEventListener('click', handler, { capture: true });
    return () => document.removeEventListener('click', handler, { capture: true });
  }, [nextBigTutorial, pathname, step, target]);

  useEffect(() => {
    if (!step?.waitFor || pathname !== step.path) return;
    if (
      step.id === 'wait-for-app-connection'
      && bigTutorialConnectedServer === bigTutorialProgress.recommendedServerName
    ) {
      void nextBigTutorial();
      return;
    }
    if (step.id === 'wait-for-app-connection') return;
    if (
      (step.id === 'wait-for-first-answer' || step.id === 'wait-for-second-answer')
      && (bigTutorialRunStatus === 'completed' || bigTutorialRunStatus === 'error')
    ) {
      void nextBigTutorial();
      return;
    }
    if (step.id === 'wait-for-first-answer' || step.id === 'wait-for-second-answer') {
      // A completion event can be missed when the tutorial is restored after a
      // reload or when settings persistence and the chat response finish in the
      // same render. The Chat root exposes its durable status, so use that as a
      // fallback instead of leaving the tutorial on "Waiting" forever.
      let timer = 0;
      const checkChat = () => {
        const finished = document.querySelector(
          '[data-tutorial-chat-status="completed"], [data-tutorial-chat-status="error"]',
        );
        if (finished) void nextBigTutorial();
        else timer = window.setTimeout(checkChat, 200);
      };
      checkChat();
      return () => window.clearTimeout(timer);
    }
    let timer = 0;
    const check = () => {
      if (document.querySelector(step.waitFor!)) void nextBigTutorial();
      else timer = window.setTimeout(check, 200);
    };
    check();
    return () => window.clearTimeout(timer);
  }, [
    bigTutorialConnectedServer,
    bigTutorialProgress.recommendedServerName,
    bigTutorialRunStatus,
    nextBigTutorial,
    pathname,
    step,
  ]);

  if (!isBigTutorialActive || !step) return null;

  const onRightPage = pathname === step.path;
  const showSpotlight = onRightPage && rect !== null;
  const position = cardPosition(showSpotlight ? rect : null, step.placement);
  const hasBack = !!step.back;
  const waiting = !!step.waitFor;
  const title = resolveBigTutorialText(step.title, bigTutorialProgress);
  const body = resolveBigTutorialText(step.body, bigTutorialProgress);

  return createPortal((
    <Box sx={{ position: 'fixed', inset: 0, zIndex: theme => theme.zIndex.modal + 220, pointerEvents: 'none' }}>
      {!showSpotlight && (
        <Box sx={{ position: 'absolute', inset: 0, bgcolor: 'rgba(0,0,0,.58)', pointerEvents: 'auto' }} />
      )}
      {showSpotlight && rect && (
        <Box sx={{
          position: 'absolute',
          top: rect.top - SPOTLIGHT_PADDING,
          left: rect.left - SPOTLIGHT_PADDING,
          width: rect.width + SPOTLIGHT_PADDING * 2,
          height: rect.height + SPOTLIGHT_PADDING * 2,
          borderRadius: 2,
          boxShadow: '0 0 0 9999px rgba(0,0,0,.58)',
          outline: theme => `2px solid ${theme.palette.primary.main}`,
          transition: 'all 180ms ease',
          pointerEvents: 'none',
        }} />
      )}

      <Paper
        elevation={10}
        data-tutorial-app-connected={
          bigTutorialConnectedServer === bigTutorialProgress.recommendedServerName ? 'true' : undefined
        }
        sx={{
        position: 'absolute', width: CARD_WIDTH, maxWidth: 'calc(100vw - 28px)', p: 2.5,
        pointerEvents: 'auto', borderRadius: 3, ...position,
      }}>
        <IconButton aria-label="Continue tutorial later" size="small" onClick={pauseBigTutorial}
          sx={{ position: 'absolute', top: 6, right: 6 }}>
          <CloseIcon fontSize="small" />
        </IconButton>

        <Typography variant="overline" color="primary.main" fontWeight={800}>
          {step.nested
            ? `Stage 1  ›  ${step.nested === 'install-web-app' ? 'Add a web app' : 'Turn on a web app'}`
            : 'Big tutorial · Stage 1'}
        </Typography>
        <Typography variant="h6" sx={{ pr: 3, mb: 1 }}>{title}</Typography>
        {body.split('\n\n').map((paragraph, index) => (
          <Typography key={index} variant="body2" color="text.secondary" sx={{ mb: 1.25 }}>
            {paragraph}
          </Typography>
        ))}

        {bigTutorialError && <Alert severity="warning" sx={{ mt: 1, mb: 1 }}>{bigTutorialError}</Alert>}

        {!step.nested && (
          <Box sx={{ mt: 1.5 }}>
            <LinearProgress variant="determinate" value={Math.min(100, ((mainIndex + 1) / mainSteps.length) * 100)} />
            <Typography variant="caption" color="text.secondary">
              {mainIndex + 1} of {mainSteps.length}
            </Typography>
          </Box>
        )}

        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, mt: 1.5 }}>
          <Button size="small" onClick={() => void backBigTutorial()} disabled={!hasBack || bigTutorialBusy}>Back</Button>
          {step.advanceOnTargetClick ? (
            <Typography variant="caption" color="primary.main" sx={{ alignSelf: 'center', fontWeight: 750 }}>
              Click the highlighted area
            </Typography>
          ) : waiting ? (
            <Button size="small" disabled startIcon={<CircularProgress size={14} />}>Waiting</Button>
          ) : step.action ? (
            <Button size="small" variant="contained" disabled={bigTutorialBusy} onClick={() => void runBigTutorialAction()}
              startIcon={bigTutorialBusy ? <CircularProgress size={14} color="inherit" /> : undefined}>
              {step.actionLabel ?? 'Continue'}
            </Button>
          ) : (
            <Button size="small" variant="contained" disabled={bigTutorialBusy} onClick={() => void nextBigTutorial()}>Next</Button>
          )}
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
          <Button size="small" color="inherit" onClick={() => void pauseBigTutorial()} sx={{ opacity: 0.75 }}>
            Continue tutorial later
          </Button>
          <Button size="small" color="inherit" onClick={() => setConfirmRestart(true)}>
            Restart from beginning
          </Button>
          <Button size="small" color="inherit" disabled={!step.next || bigTutorialBusy} onClick={() => void nextBigTutorial()}>
            Skip
          </Button>
        </Box>
      </Paper>

      <Dialog open={confirmRestart} onClose={() => setConfirmRestart(false)} sx={{ pointerEvents: 'auto' }}>
        <DialogTitle>Restart Stage 1?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This clears your saved place and starts the tutorial again from the beginning. It does not delete your agent, conversations, or connected apps.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRestart(false)}>Keep tutorial</Button>
          <Button
            color="primary"
            variant="contained"
            onClick={() => {
              setConfirmRestart(false);
              void restartBigTutorial();
            }}
          >
            Restart tutorial
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  ), document.body);
}
