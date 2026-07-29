"use client";

import React, { useEffect, useState } from 'react';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import PauseCircleOutlineIcon from '@mui/icons-material/PauseCircleOutline';
import BugReportIcon from '@mui/icons-material/BugReport';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import { LiveLane, LiveLanes, laneList } from '@/utils/shared/liveLanes';

const workingActivities = [
  'Painting the fence', 'Watching the 1954 World Cup', 'Drying behind the ears',
  'Attending the first moon landing', 'Fighting in the Thirty Years’ War', 'Discovering fire',
  'Playing with the cats', 'Cutting down a tree', 'Plumbing a drain', 'Eating a sandwich',
  'Committing tax fraud', 'Awaiting GTA 7', 'Going on a demonstration', 'Driving in the left lane',
  'Repairing an old chair', 'Exploring magnetism', 'Teaching a goldfish algebra',
  'Alphabetizing the spice rack', 'Polishing a brass telescope', 'Folding a fitted sheet',
  'Training for the snail marathon', 'Counting the rings of Saturn', 'Sharpening a box of crayons',
  'Negotiating with the squirrels', 'Rehearsing a dramatic entrance', 'Mapping an imaginary island',
  'Baking a suspiciously round pie', 'Tuning a haunted piano', 'Watering the plastic plants',
  'Untangling holiday lights', 'Building a pillow fortress', 'Decoding the grocery list',
  'Interviewing a garden gnome', 'Organizing the sock drawer', 'Following a trail of breadcrumbs',
  'Inventing a quieter kazoo', 'Dusting the dinosaur bones', 'Launching a paper airplane',
  'Measuring the speed of gossip', 'Teaching robots to whistle', 'Calibrating the sundial',
  'Searching for buried treasure', 'Painting clouds on the ceiling', 'Refilling the office stapler',
  'Herding digital cats', 'Consulting the ancient scrolls', 'Testing the emergency hammock',
  'Translating whale songs', 'Perfecting the secret handshake', 'Winding the grandfather clock',
  'Chasing the northern lights', 'Sailing across a coffee cup', 'Planting a tiny forest',
  'Borrowing sugar from the neighbors', 'Learning the penguin shuffle', 'Auditioning for a silent movie',
  'Restoring a medieval tapestry', 'Naming every star', 'Packing for an expedition',
  'Composing an elevator symphony', 'Inspecting the castle moat', 'Reading tea leaves',
  'Assembling a model volcano', 'Studying the migration of sandwiches', 'Racing a steam locomotive',
  'Picnicking beside a black hole', 'Practicing wizard etiquette', 'Delivering mail by pigeon',
  'Searching the library stacks', 'Brewing a heroic cup of tea', 'Drawing moustaches on portraits',
  'Balancing the household budget', 'Learning to speak dolphin', 'Mending a pirate sail',
  'Surveying the ocean floor', 'Opening a detective agency', 'Carving a wooden spoon',
  'Observing the neighborhood dragons', 'Crossing the Silk Road', 'Preparing for the robot uprising',
  'Writing a strongly worded postcard', 'Spinning plates at the circus', 'Evicting ghosts from the attic',
  'Charting the Bermuda Triangle', 'Making friends with the ravens', 'Designing a moon garden',
  'Investigating the cookie jar', 'Practicing synchronized napping', 'Mining cheese on the Moon',
  'Repairing the time machine', 'Conducting the dawn chorus', 'Waiting for paint to dry',
  'Solving the sphinx’s riddle', 'Building a better mousetrap', 'Exploring an underwater city',
  'Sorting the wizard’s mail', 'Escaping an awkward conversation', 'Raking leaves in a hurricane',
  'Guarding the last doughnut', 'Looking busy',
] as const;

const workingCircumstances = [
  '', ' before breakfast', ' under a full moon', ' with expert supervision',
  ' somewhere off the map', ' according to ancient custom', ' while nobody is looking',
  ' for science', ' one tiny step at a time', ' against all reasonable advice',
] as const;

/** 100 activities × 10 circumstances = exactly 1,000 distinct messages. */
export const WORKING_MESSAGES: readonly string[] = workingActivities.flatMap(activity =>
  workingCircumstances.map(circumstance => `${activity}${circumstance}…`),
);

/** Live execution stats, driven by the SSE event stream while a run is active. */
export interface LiveRunStats {
  totalTokens: number;
  activeNode: string | null;
  startedAt: number;
  lastEventAt: number;
}

interface LiveRunIndicatorProps {
  liveStats: LiveRunStats | null;
  onStop: () => void;
  stopDisabled?: boolean;
  /** The run is parked at a tool-approval prompt: swap the spinner (which would
   *  falsely suggest activity next to the Approve/Reject buttons) for a static
   *  pause icon, and drop the elapsed/stall caption — but keep Stop reachable,
   *  since the run is still alive and holding the conversation. */
  awaitingApproval?: boolean;
  /** Per-lane progress rows for a parallel subflow fan-out (issue #157).
   *  Empty/absent → the exact pre-lane rendering. */
  lanes?: LiveLanes;
  /** Open a lane's persisted sidebar conversation (rows are clickable only
   *  when the lane carries a laneConversationId). */
  onOpenLane?: (conversationId: string) => void;
  /** Attach the debugger to this in-flight run: arms a one-shot breakpoint so
   *  execution pauses before the next node and opens the debugger panel. Only
   *  provided for a foreground (tracked) run — absent → no button. */
  onAttachDebugger?: () => void;
}

/** One compact progress row per lane: status icon, brief/label, current
 *  activity — clickable through to the lane's own conversation when it is
 *  persisted. The header above stays the parent's (activeNode is never
 *  touched by lane events), so dispatch, join and the post-join synthesis
 *  step all remain visible while the rows tell the per-worker story. */
const LaneRow: React.FC<{ lane: LiveLane; onOpenLane?: (conversationId: string) => void }> = ({ lane, onOpenLane }) => {
  const clickable = !!lane.laneConversationId && !!onOpenLane;
  const pending = lane.status === 'pending';
  return (
    <Box
      onClick={clickable ? () => onOpenLane!(lane.laneConversationId!) : undefined}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1,
        py: 0.25,
        borderRadius: 1,
        ...(clickable && {
          cursor: 'pointer',
          '&:hover': { bgcolor: 'action.hover', textDecoration: 'underline' },
        }),
      }}
    >
      {lane.status === 'running' && <CircularProgress size={14} sx={{ flexShrink: 0 }} />}
      {lane.status === 'completed' && <CheckCircleIcon sx={{ fontSize: 16, flexShrink: 0 }} color="success" />}
      {lane.status === 'error' && <CancelIcon sx={{ fontSize: 16, flexShrink: 0 }} color="error" />}
      {pending && <RadioButtonUncheckedIcon sx={{ fontSize: 16, flexShrink: 0 }} color="disabled" />}
      <Typography
        variant="caption"
        color={pending ? 'text.disabled' : 'textSecondary'}
        sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {lane.label}
        {pending && ' — queued'}
        {lane.status === 'running' && lane.activity && (
          <Typography component="span" variant="caption" color="text.disabled">
            {' · '}{lane.activity}
          </Typography>
        )}
      </Typography>
    </Box>
  );
};

/** Summary caption for the lane block; switches to the warning-colored
 *  partial-failure marker once every lane is terminal and some failed. */
const laneSummary = (rows: LiveLane[]): { text: string; warning: boolean } => {
  const running = rows.filter(l => l.status === 'running').length;
  const queued = rows.filter(l => l.status === 'pending').length;
  const done = rows.filter(l => l.status === 'completed').length;
  const failed = rows.filter(l => l.status === 'error').length;
  if (running === 0 && queued === 0 && failed > 0) {
    return { text: `${failed}/${rows.length} lanes failed — partial results`, warning: true };
  }
  const parts = [
    running > 0 ? `${running} running` : '',
    queued > 0 ? `${queued} queued` : '',
    done > 0 ? `${done} done` : '',
    failed > 0 ? `${failed} failed` : '',
  ].filter(Boolean);
  return { text: `${rows.length} lanes — ${parts.join(', ')}`, warning: failed > 0 };
};

/**
 * The "Running… N tokens · Ns elapsed" indicator with its own 1-second tick.
 *
 * The tick lives HERE, not in the Chat container: when it sat in Chat, every
 * second re-rendered the entire component tree — including every message
 * bubble with its markdown parse — for the whole duration of a run. Mounted
 * only while the viewed conversation is running, so the interval's lifecycle
 * is simply this component's lifecycle.
 */
const LiveRunIndicator: React.FC<LiveRunIndicatorProps> = ({ liveStats, onStop, stopDisabled, awaitingApproval, lanes, onOpenLane, onAttachDebugger }) => {
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  // Once armed, the pause fires at the next node and this component unmounts
  // (the debugger panel takes over), so the transient "Attaching…" state clears
  // itself. Guards against re-arming with repeated clicks in the meantime.
  const [attaching, setAttaching] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = liveStats ? Math.max(0, Math.round((nowTick - liveStats.startedAt) / 1000)) : 0;
  const sinceLast = liveStats ? Math.round((nowTick - liveStats.lastEventAt) / 1000) : 0;
  const stuck = !awaitingApproval && !!liveStats && sinceLast >= 60;
  const messageOffset = liveStats ? Math.floor(liveStats.startedAt / 1000) % WORKING_MESSAGES.length : 0;
  const workingMessage = WORKING_MESSAGES[
    (messageOffset + Math.floor(elapsed / 5)) % WORKING_MESSAGES.length
  ];

  const laneRows = lanes ? laneList(lanes) : [];
  const summary = laneRows.length > 0 ? laneSummary(laneRows) : null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', my: 2, gap: 0.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        {awaitingApproval ? (
          <PauseCircleOutlineIcon fontSize="small" color="warning" />
        ) : (
          <CircularProgress size={20} color={stuck ? 'warning' : 'primary'} />
        )}
        <Typography variant="body2" color="textSecondary">
          {awaitingApproval
            ? 'Waiting for tool approval'
            : liveStats?.activeNode ? `Running: ${liveStats.activeNode}` : 'Working…'}
        </Typography>
        {onAttachDebugger && !awaitingApproval && (
          <Button
            variant="outlined"
            color="primary"
            size="small"
            startIcon={<BugReportIcon fontSize="small" />}
            onClick={() => { setAttaching(true); onAttachDebugger(); }}
            disabled={attaching}
          >
            {attaching ? 'Attaching…' : 'Attach debugger'}
          </Button>
        )}
        <Button
          variant="outlined"
          color="secondary"
          size="small"
          onClick={onStop}
          disabled={stopDisabled}
        >
          Stop
        </Button>
      </Box>
      {!awaitingApproval && (
        <Typography
          variant="caption"
          color="text.disabled"
          sx={{ fontStyle: 'italic' }}
          aria-live="polite"
        >
          {workingMessage}
        </Typography>
      )}
      {summary && (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', minWidth: 280, maxWidth: 520 }}>
          <Typography
            variant="caption"
            color={summary.warning ? 'warning.main' : 'textSecondary'}
            sx={{ px: 1, fontWeight: 500 }}
          >
            {summary.text}
          </Typography>
          {laneRows.map(lane => (
            <LaneRow key={lane.laneIndex} lane={lane} onOpenLane={onOpenLane} />
          ))}
        </Box>
      )}
      {!awaitingApproval && (
        <Typography variant="caption" color={stuck ? 'warning.main' : 'textSecondary'}>
          {(liveStats?.totalTokens ?? 0).toLocaleString()} tokens · {elapsed}s elapsed
          {stuck ? ` · no activity for ${sinceLast}s — may be stuck` : ''}
        </Typography>
      )}
    </Box>
  );
};

export default LiveRunIndicator;
