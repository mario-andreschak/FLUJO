"use client";

import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Checkbox,
  Divider,
  FormControl,
  FormControlLabel,
  FormGroup,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { Flow } from '@/frontend/types/flow/flow';
import { FlowEventTriggerConfig } from '@/shared/types/plannedExecution';
import {
  plannedExecutionsService,
  PlannedExecutionListEntry,
} from '@/frontend/services/plannedExecutions';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/PlannedExecutions/FlowEventPanel');

interface FlowEventPanelProps {
  config: FlowEventTriggerConfig;
  onChange: (config: FlowEventTriggerConfig) => void;
  /** Flows already loaded by the modal (source picker options). */
  flows: Flow[];
  /** The execution being edited (excluded from the source list to avoid the
   *  obvious self-loop as a default choice). */
  currentExecutionId?: string;
}

type SourceKind = 'flow' | 'execution' | 'topic';

/**
 * Flow-event trigger editor (issue #116): run this flow when ANOTHER flow (or a
 * specific planned execution) finishes or errors. Source is exactly one of a
 * flow or a planned execution; outcomes are completed/error; an optional output
 * filter and loop-safety knobs (max chain depth, cooldown) are under Advanced.
 */
const FlowEventPanel = ({ config, onChange, flows, currentExecutionId }: FlowEventPanelProps) => {
  const [executions, setExecutions] = useState<PlannedExecutionListEntry[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(
    config.maxChainDepth !== undefined || config.minIntervalMs !== undefined
  );

  const sourceKind: SourceKind = config.source?.topic !== undefined
    ? 'topic'
    : config.source?.executionId !== undefined
    ? 'execution'
    : 'flow';
  const isTopic = sourceKind === 'topic';

  useEffect(() => {
    let cancelled = false;
    plannedExecutionsService
      .list()
      .then((res) => {
        if (!cancelled) setExecutions(res.executions || []);
      })
      .catch((err) => {
        log.warn('Failed to load planned executions for source picker', err);
        if (!cancelled) setExecutions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setSourceKind = (kind: SourceKind) => {
    // Reset the source to the chosen dimension so exactly one field is ever set.
    const source =
      kind === 'flow' ? { flowId: '' } : kind === 'execution' ? { executionId: '' } : { topic: '' };
    onChange({ ...config, source });
  };

  const toggleOutcome = (outcome: 'completed' | 'error', checked: boolean) => {
    const next = new Set(config.on ?? []);
    if (checked) next.add(outcome);
    else next.delete(outcome);
    onChange({ ...config, on: Array.from(next) });
  };

  return (
    <Box sx={{ mt: 1 }}>
      <Typography variant="subtitle2" sx={{ mt: 1 }}>
        React to
      </Typography>
      <Box sx={{ display: 'flex', gap: 2, mt: 1 }}>
        <FormControl sx={{ minWidth: 180 }}>
          <InputLabel id="flow-event-source-kind">Source</InputLabel>
          <Select
            labelId="flow-event-source-kind"
            label="Source"
            value={sourceKind}
            onChange={(e) => setSourceKind(e.target.value as SourceKind)}
          >
            <MenuItem value="flow">A flow (any run)</MenuItem>
            <MenuItem value="execution">A planned execution</MenuItem>
            <MenuItem value="topic">A signal topic</MenuItem>
          </Select>
        </FormControl>

        {sourceKind === 'topic' ? (
          <FormControl fullWidth>
            <TextField
              label="Signal topic"
              value={config.source?.topic ?? ''}
              onChange={(e) => onChange({ ...config, source: { topic: e.target.value } })}
              placeholder="e.g. review-blocked"
              helperText="React when a signal node in any flow emits this topic."
            />
          </FormControl>
        ) : sourceKind === 'flow' ? (
          <FormControl fullWidth>
            <InputLabel id="flow-event-flow">Flow to watch</InputLabel>
            <Select
              labelId="flow-event-flow"
              label="Flow to watch"
              value={config.source?.flowId ?? ''}
              onChange={(e) => onChange({ ...config, source: { flowId: e.target.value } })}
              displayEmpty
            >
              {flows.length === 0 && (
                <MenuItem value="" disabled>
                  No flows available
                </MenuItem>
              )}
              {flows.map((f) => (
                <MenuItem key={f.id} value={f.id}>
                  {f.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        ) : (
          <FormControl fullWidth>
            <InputLabel id="flow-event-execution">Planned execution to watch</InputLabel>
            <Select
              labelId="flow-event-execution"
              label="Planned execution to watch"
              value={config.source?.executionId ?? ''}
              onChange={(e) => onChange({ ...config, source: { executionId: e.target.value } })}
              displayEmpty
            >
              {executions.filter((e) => e.execution.id !== currentExecutionId).length === 0 && (
                <MenuItem value="" disabled>
                  No other planned executions
                </MenuItem>
              )}
              {executions
                .filter((e) => e.execution.id !== currentExecutionId)
                .map((e) => (
                  <MenuItem key={e.execution.id} value={e.execution.id}>
                    {e.execution.name}
                  </MenuItem>
                ))}
            </Select>
          </FormControl>
        )}
      </Box>

      {!isTopic && (
        <>
          <Typography variant="subtitle2" sx={{ mt: 2 }}>
            When it…
          </Typography>
          <FormGroup row>
            <FormControlLabel
              control={
                <Checkbox
                  checked={(config.on ?? []).includes('completed')}
                  onChange={(e) => toggleOutcome('completed', e.target.checked)}
                />
              }
              label="completes"
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={(config.on ?? []).includes('error')}
                  onChange={(e) => toggleOutcome('error', e.target.checked)}
                />
              }
              label="errors"
            />
          </FormGroup>
        </>
      )}

      <TextField
        fullWidth
        label={isTopic ? 'Only when the payload contains (optional)' : 'Only when the output contains (optional)'}
        value={config.outputMatch?.contains ?? ''}
        onChange={(e) => {
          const contains = e.target.value;
          const outputMatch = { ...config.outputMatch, contains: contains || undefined };
          const cleaned =
            outputMatch.contains || outputMatch.regex ? outputMatch : undefined;
          onChange({ ...config, outputMatch: cleaned });
        }}
        margin="normal"
        placeholder="e.g. FAILED, or leave empty to react to every matching run"
      />

      <FormControlLabel
        sx={{ mt: 1 }}
        control={
          <Checkbox checked={showAdvanced} onChange={(e) => setShowAdvanced(e.target.checked)} />
        }
        label="Advanced (loop safety)"
      />
      {showAdvanced && (
        <Box sx={{ display: 'flex', gap: 2, mt: 1 }}>
          <TextField
            label="Max chain depth"
            type="number"
            value={config.maxChainDepth ?? ''}
            onChange={(e) =>
              onChange({
                ...config,
                maxChainDepth: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            helperText="Stop after this many hops (default 5)"
            inputProps={{ min: 1 }}
          />
          <TextField
            label="Cooldown (ms)"
            type="number"
            value={config.minIntervalMs ?? ''}
            onChange={(e) =>
              onChange({
                ...config,
                minIntervalMs: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            helperText="Minimum gap between fires"
            inputProps={{ min: 0 }}
          />
        </Box>
      )}

      <Divider sx={{ mt: 2 }} />
      <Alert severity="info" sx={{ mt: 2 }}>
        {isTopic
          ? 'The signal’s payload is handed to this flow. Emit a signal from a signal node in any flow to fire this one — fire-and-forget. To avoid runaway loops, a chain of fires stops at the max depth above, and the overlap-skip prevents a single execution from re-triggering itself while it’s still running.'
          : 'The upstream run’s output is handed to this flow, so it can build on what the other flow produced. To avoid runaway loops, a chain of flow-event fires stops at the max depth above, and the existing overlap-skip prevents a single execution from re-triggering itself while it’s still running.'}
      </Alert>
    </Box>
  );
};

export default FlowEventPanel;
