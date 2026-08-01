"use client";

import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
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
import { buildTopicEmitterIndex } from '@/shared/utils/signalTopics';
import { createLogger } from '@/utils/logger';
import { useI18n } from '@/frontend/contexts/I18nContext';

/** One planned execution that already subscribes to a given signal topic. */
interface TopicSubscriber {
  executionId: string;
  executionName: string;
  flowId: string;
  flowName?: string;
}

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
  const { t, tp } = useI18n();
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

  // Signal-topic discovery (issue #165): derive, entirely client-side from data
  // already loaded by the modal, which topics are emitted where and which other
  // triggers already consume them — no new API calls.
  const topicIndex = useMemo(() => buildTopicEmitterIndex(flows), [flows]);

  const flowNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of flows) if (f?.id) m.set(f.id, f.name);
    return m;
  }, [flows]);

  const subscribersByTopic = useMemo(() => {
    const m = new Map<string, TopicSubscriber[]>();
    for (const entry of executions) {
      const exec = entry.execution;
      if (exec.id === currentExecutionId) continue; // don't list the execution being edited
      if (exec.trigger?.type !== 'flow-event') continue;
      const topic = exec.trigger.source?.topic;
      if (typeof topic !== 'string' || !topic.trim()) continue;
      const key = topic.trim();
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push({
        executionId: exec.id,
        executionName: exec.name,
        flowId: exec.flowId,
        flowName: flowNameById.get(exec.flowId),
      });
    }
    return m;
  }, [executions, currentExecutionId, flowNameById]);

  // Option list = every emitted topic ∪ every topic already subscribed to.
  const topicOptions = useMemo(
    () =>
      Array.from(new Set([...topicIndex.keys(), ...subscribersByTopic.keys()])).sort((a, b) =>
        a.localeCompare(b),
      ),
    [topicIndex, subscribersByTopic],
  );

  const describeEmitters = (topic: string): string | null => {
    const emitters = topicIndex.get(topic);
    if (!emitters || emitters.length === 0) return null;
    const names = Array.from(
      new Set(
        emitters.map(
          (e) => (e.flowName || e.flowId) + (e.viaSubflow ? ` (${t('automations.event.viaSubflow')})` : ''),
        ),
      ),
    );
    return t('automations.event.emittedIn', { names: names.join(', ') });
  };

  const describeSubscribers = (topic: string): string | null => {
    const subs = subscribersByTopic.get(topic);
    if (!subs || subs.length === 0) return null;
    const startedFlows = Array.from(
      new Set(subs.map((s) => s.flowName || s.flowId)),
    );
    return tp('automations.event.usedBy', subs.length, { flows: startedFlows.join(', ') });
  };

  const currentTopic = (config.source?.topic ?? '').trim();
  const topicHasEmitter = currentTopic ? topicIndex.has(currentTopic) : true;

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
        {t('automations.event.reactTo')}
      </Typography>
      <Box sx={{ display: 'flex', gap: 2, mt: 1 }}>
        <FormControl sx={{ minWidth: 180 }}>
          <InputLabel id="flow-event-source-kind">{t('automations.event.source')}</InputLabel>
          <Select
            labelId="flow-event-source-kind"
            label={t('automations.event.source')}
            value={sourceKind}
            onChange={(e) => setSourceKind(e.target.value as SourceKind)}
          >
            <MenuItem value="flow">{t('automations.event.sourceFlow')}</MenuItem>
            <MenuItem value="execution">{t('automations.event.sourceExecution')}</MenuItem>
            <MenuItem value="topic">{t('automations.event.sourceTopic')}</MenuItem>
          </Select>
        </FormControl>

        {sourceKind === 'topic' ? (
          <FormControl fullWidth>
            <Autocomplete
              freeSolo
              autoHighlight
              options={topicOptions}
              value={config.source?.topic ?? ''}
              inputValue={config.source?.topic ?? ''}
              onInputChange={(_, value) =>
                onChange({ ...config, source: { topic: value } })
              }
              renderOption={(props, option) => {
                const emitters = describeEmitters(option);
                const subs = describeSubscribers(option);
                return (
                  <Box component="li" {...props} key={option}>
                    <Box sx={{ display: 'flex', flexDirection: 'column', py: 0.25 }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {option}
                      </Typography>
                      {emitters && (
                        <Typography variant="caption" color="text.secondary">
                          {emitters}
                        </Typography>
                      )}
                      {subs && (
                        <Typography variant="caption" color="text.secondary">
                          {subs}
                        </Typography>
                      )}
                      {!emitters && (
                        <Typography variant="caption" color="warning.main">
                          {t('automations.event.noEmitter')}
                        </Typography>
                      )}
                    </Box>
                  </Box>
                );
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={t('automations.event.signalTopic')}
                  placeholder={t('automations.event.topicPlaceholder')}
                  helperText={
                    !currentTopic
                      ? t('automations.event.topicEmptyHelp')
                      : topicHasEmitter
                      ? describeEmitters(currentTopic) ?? t('automations.event.topicEmittedHelp')
                      : t('automations.event.topicIdleHelp')
                  }
                />
              )}
            />
          </FormControl>
        ) : sourceKind === 'flow' ? (
          <FormControl fullWidth>
            <InputLabel id="flow-event-flow">{t('automations.event.flowToWatch')}</InputLabel>
            <Select
              labelId="flow-event-flow"
              label={t('automations.event.flowToWatch')}
              value={config.source?.flowId ?? ''}
              onChange={(e) => onChange({ ...config, source: { flowId: e.target.value } })}
              displayEmpty
            >
              {flows.length === 0 && (
                <MenuItem value="" disabled>
                  {t('automations.tool.noFlows')}
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
            <InputLabel id="flow-event-execution">{t('automations.event.executionToWatch')}</InputLabel>
            <Select
              labelId="flow-event-execution"
              label={t('automations.event.executionToWatch')}
              value={config.source?.executionId ?? ''}
              onChange={(e) => onChange({ ...config, source: { executionId: e.target.value } })}
              displayEmpty
            >
              {executions.filter((e) => e.execution.id !== currentExecutionId).length === 0 && (
                <MenuItem value="" disabled>
                  {t('automations.event.noOtherExecutions')}
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
            {t('automations.event.whenIt')}
          </Typography>
          <FormGroup row>
            <FormControlLabel
              control={
                <Checkbox
                  checked={(config.on ?? []).includes('completed')}
                  onChange={(e) => toggleOutcome('completed', e.target.checked)}
                />
              }
              label={t('automations.event.completes')}
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={(config.on ?? []).includes('error')}
                  onChange={(e) => toggleOutcome('error', e.target.checked)}
                />
              }
              label={t('automations.event.errors')}
            />
          </FormGroup>
        </>
      )}

      <TextField
        fullWidth
        label={isTopic ? t('automations.event.payloadContains') : t('automations.event.outputContains')}
        value={config.outputMatch?.contains ?? ''}
        onChange={(e) => {
          const contains = e.target.value;
          const outputMatch = { ...config.outputMatch, contains: contains || undefined };
          const cleaned =
            outputMatch.contains || outputMatch.regex ? outputMatch : undefined;
          onChange({ ...config, outputMatch: cleaned });
        }}
        margin="normal"
        placeholder={t('automations.event.containsPlaceholder')}
      />

      <FormControlLabel
        sx={{ mt: 1 }}
        control={
          <Checkbox checked={showAdvanced} onChange={(e) => setShowAdvanced(e.target.checked)} />
        }
        label={t('automations.event.loopSafety')}
      />
      {showAdvanced && (
        <Box sx={{ display: 'flex', gap: 2, mt: 1 }}>
          <TextField
            label={t('automations.event.maxDepth')}
            type="number"
            value={config.maxChainDepth ?? ''}
            onChange={(e) =>
              onChange({
                ...config,
                maxChainDepth: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            helperText={t('automations.event.maxDepthHelp')}
            inputProps={{ min: 1 }}
          />
          <TextField
            label={t('automations.event.cooldown')}
            type="number"
            value={config.minIntervalMs ?? ''}
            onChange={(e) =>
              onChange({
                ...config,
                minIntervalMs: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            helperText={t('automations.event.cooldownHelp')}
            inputProps={{ min: 0 }}
          />
        </Box>
      )}

      <Divider sx={{ mt: 2 }} />
      <Alert severity="info" sx={{ mt: 2 }}>
        {isTopic
          ? t('automations.event.topicInfo')
          : t('automations.event.flowInfo')}
      </Alert>
    </Box>
  );
};

export default FlowEventPanel;
