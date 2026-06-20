"use client";

import React, { useEffect, useLayoutEffect, useState } from 'react';
import { Box, Button, Paper, Typography, MobileStepper } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import IconButton from '@mui/material/IconButton';
import { usePathname, useRouter } from 'next/navigation';
import { useTour } from '@/frontend/contexts/TourContext';
import { TOUR_STEPS, TourStep } from '@/frontend/components/Tour/tourSteps';

const SPOTLIGHT_PADDING = 8;
const CARD_WIDTH = 360;
const CARD_GAP = 16;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Compute where the card should sit relative to the spotlit target. */
function computeCardPosition(rect: Rect | null, placement: TourStep['placement']): React.CSSProperties {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;

  if (!rect || placement === 'center') {
    return {
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
    };
  }

  let top: number;
  let left: number;

  switch (placement) {
    case 'top':
      top = rect.top - CARD_GAP;
      left = rect.left + rect.width / 2;
      return clamp({ top, left, vw, vh, transform: 'translate(-50%, -100%)' });
    case 'left':
      top = rect.top + rect.height / 2;
      left = rect.left - CARD_GAP;
      return clamp({ top, left, vw, vh, transform: 'translate(-100%, -50%)' });
    case 'right':
      top = rect.top + rect.height / 2;
      left = rect.left + rect.width + CARD_GAP;
      return clamp({ top, left, vw, vh, transform: 'translate(0, -50%)' });
    case 'bottom':
    default:
      top = rect.top + rect.height + CARD_GAP;
      left = rect.left + rect.width / 2;
      return clamp({ top, left, vw, vh, transform: 'translate(-50%, 0)' });
  }
}

/** Keep the card horizontally on-screen; vertical clamping is best-effort. */
function clamp({
  top,
  left,
  vw,
  transform,
}: {
  top: number;
  left: number;
  vw: number;
  vh: number;
  transform: string;
}): React.CSSProperties {
  const half = CARD_WIDTH / 2;
  let clampedLeft = left;
  // For center-anchored transforms, keep the whole card within the viewport.
  if (transform.includes('-50%, -100%') || transform.includes('-50%, 0')) {
    clampedLeft = Math.min(Math.max(left, half + 8), vw - half - 8);
  }
  return { top, left: clampedLeft, transform };
}

export default function TourOverlay() {
  const { isActive, stepIndex, next, back, endTour } = useTour();
  const pathname = usePathname();
  const router = useRouter();
  const [rect, setRect] = useState<Rect | null>(null);

  const step = isActive ? TOUR_STEPS[stepIndex] : undefined;

  // Navigate to the step's page if we're not already there.
  useEffect(() => {
    if (!step) return;
    if (pathname !== step.path) {
      router.push(step.path);
    }
  }, [step, pathname, router]);

  // Track the target element's position. Polls while the step is active so the
  // spotlight follows layout shifts, scrolling, and post-navigation mounts.
  useLayoutEffect(() => {
    if (!step) {
      setRect(null);
      return;
    }
    // Don't try to locate the target until we're on the right page.
    if (pathname !== step.path) {
      setRect(null);
      return;
    }

    let raf = 0;
    let scrolledIntoView = false;

    const measure = () => {
      if (step.target) {
        const el = document.querySelector(step.target) as HTMLElement | null;
        if (el) {
          if (!scrolledIntoView) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            scrolledIntoView = true;
          }
          const r = el.getBoundingClientRect();
          setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
        } else {
          setRect(null);
        }
      } else {
        setRect(null);
      }
      raf = window.setTimeout(measure, 200) as unknown as number;
    };

    measure();
    return () => window.clearTimeout(raf);
  }, [step, pathname, stepIndex]);

  if (!isActive || !step) {
    return null;
  }

  const onRightPage = pathname === step.path;
  const showSpotlight = onRightPage && rect !== null;
  const cardPosition = computeCardPosition(showSpotlight ? rect : null, step.placement);
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === TOUR_STEPS.length - 1;

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: (theme) => theme.zIndex.modal + 200,
        pointerEvents: 'none',
      }}
    >
      {/* Backdrop. When a target is spotlit we use the box-shadow cutout below
          instead, so this full-screen dim only shows for centered steps. */}
      {!showSpotlight && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.55)',
            pointerEvents: 'auto',
          }}
        />
      )}

      {/* Spotlight cutout around the target element. */}
      {showSpotlight && rect && (
        <Box
          sx={{
            position: 'absolute',
            top: rect.top - SPOTLIGHT_PADDING,
            left: rect.left - SPOTLIGHT_PADDING,
            width: rect.width + SPOTLIGHT_PADDING * 2,
            height: rect.height + SPOTLIGHT_PADDING * 2,
            borderRadius: 1.5,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
            outline: (theme) => `2px solid ${theme.palette.primary.main}`,
            transition: 'all 0.2s ease',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Step card */}
      <Paper
        elevation={8}
        sx={{
          position: 'absolute',
          width: CARD_WIDTH,
          maxWidth: 'calc(100vw - 32px)',
          p: 2.5,
          pointerEvents: 'auto',
          ...cardPosition,
        }}
      >
        <IconButton
          aria-label="Close tour"
          size="small"
          onClick={endTour}
          sx={{ position: 'absolute', top: 6, right: 6 }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>

        <Typography variant="h6" gutterBottom sx={{ pr: 3 }}>
          {step.title}
        </Typography>

        {step.body.split('\n\n').map((para, i) => (
          <Typography key={i} variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            {para}
          </Typography>
        ))}

        <MobileStepper
          variant="dots"
          steps={TOUR_STEPS.length}
          position="static"
          activeStep={stepIndex}
          sx={{ background: 'transparent', px: 0, mt: 1 }}
          nextButton={
            <Button size="small" variant="contained" onClick={next}>
              {isLast ? 'Finish' : 'Next'}
            </Button>
          }
          backButton={
            <Button size="small" onClick={back} disabled={isFirst}>
              Back
            </Button>
          }
        />

        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 0.5 }}>
          {!isLast && (
            <Button size="small" color="inherit" onClick={endTour} sx={{ opacity: 0.7 }}>
              Skip tour
            </Button>
          )}
        </Box>
      </Paper>
    </Box>
  );
}
