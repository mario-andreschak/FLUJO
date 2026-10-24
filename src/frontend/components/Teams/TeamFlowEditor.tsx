'use client';

import { useRef, useState } from 'react';
import { Alert, Box, Button, Checkbox, FormControlLabel, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { ReactFlow, Background, Controls, ConnectionMode, applyNodeChanges, type Edge } from '@xyflow/react';
import type { FlowNode } from '@/shared/types/flow';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { StartNode, ProcessNode, FinishNode, MCPNode, SubflowNode, ResourceNode, SignalNode, TriggerNode, StaticNode,
  FlowQuickConnectEnabledContext } from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomNodes';
import { CustomEdge, MCPEdge, ResourceEdge } from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomEdges';
import { canConvertToBidirectional, createEdgeFromConnection, getReplacedEdgeIds, isConnectionAllowed } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/edgeUtils';
import { flowDependencies, setFlowDependency, sharedFlowNodeTypes, sharedFlowProperties, teamDependencyId,
  type SharedFlowDocument, type SharedResource } from '@/frontend/services/teams';

const nodeTypes = { start: StartNode, process: ProcessNode, finish: FinishNode, mcp: MCPNode, subflow: SubflowNode,
  resource: ResourceNode, signal: SignalNode, trigger: TriggerNode, static: StaticNode };
const edgeTypes = { custom: CustomEdge, mcpEdge: MCPEdge, resourceEdge: ResourceEdge };
type NodeType = typeof sharedFlowNodeTypes[number];
type Props = { value: SharedFlowDocument; teamId: string; resources: SharedResource[]; disabled: boolean;
  initialDraftFields?: Record<string, string>;
  onChange: (value: SharedFlowDocument) => void; onDraftFieldsChange: (value: Record<string, string>) => void; };

/** Native graph components and connection rules, with no private catalogue,
 * provider, clipboard, schedule, AI-assistance or workspace-write calls. */
export default function TeamFlowEditor({ value, teamId, resources, disabled, onChange, onDraftFieldsChange, initialDraftFields = {} }: Props) {
  const { t } = useI18n(); const [selectedId, selectNode] = useState(''); const [selectedEdge, selectEdge] = useState('');
  const [newType, setNewType] = useState<NodeType>('process'); const [newProperty, setNewProperty] = useState('');
  const [propertyDrafts, setPropertyDrafts] = useState<Record<string, string>>(initialDraftFields); const [error, setError] = useState('');
  const history = useRef<SharedFlowDocument[]>([]); const future = useRef<SharedFlowDocument[]>([]);
  const rawFields = useRef(propertyDrafts);
  const rawDraft = (key: string, raw?: string) => {
    const next = { ...rawFields.current }; if (raw === undefined) delete next[key]; else next[key] = raw;
    rawFields.current = next;
    setPropertyDrafts(next); onDraftFieldsChange(next);
  };
  const current = value.flow.nodes.find(node => node.id === selectedId);
  const edge = value.flow.edges.find(item => item.id === selectedEdge);
  const slots = current ? flowDependencies({ ...value, flow: { ...value.flow, nodes: [current] } }) : [];
  const nodes = value.flow.nodes.map(node => ({ ...node, selected: node.id === selectedId })) as FlowNode[];
  const edges = value.flow.edges.map(item => ({ ...item, selected: item.id === selectedEdge })) as Edge[];
  const commit = (next: SharedFlowDocument) => {
    if (disabled) return;
    const existing = new Set(next.flow.nodes.flatMap(node => Object.keys(node.data.properties).map(key => `${node.id}:${key}`)));
    for (const item of next.flow.edges) existing.add(`edge:${item.id}`);
    const retained = Object.fromEntries(Object.entries(rawFields.current).filter(([key]) => existing.has(key)));
    if (Object.keys(retained).length !== Object.keys(rawFields.current).length) {
      rawFields.current = retained; setPropertyDrafts(retained); onDraftFieldsChange(retained); setError('');
    }
    history.current = [...history.current.slice(-39), structuredClone(value)]; future.current = []; onChange(next);
  };
  const updateProperties = (properties: Record<string, unknown>) => {
    if (!current) return;
    commit({ ...value, flow: { ...value.flow, nodes: value.flow.nodes.map(node => node.id === current.id ? { ...node, data: { ...node.data, properties } } : node) } });
  };
  const addNode = () => {
    const id = crypto.randomUUID(); const properties: Record<string, unknown> = {};
    if (newType === 'process') properties.boundModel = '';
    if (newType === 'mcp') properties.boundServer = '';
    if (newType === 'subflow') properties.subflowId = '';
    if (newType === 'resource') { properties.scope = 'run'; properties.runName = ''; }
    if (newType === 'static') properties.entries = [];
    commit({ ...value, flow: { ...value.flow, nodes: [...value.flow.nodes, { id, type: newType,
      position: { x: (value.flow.nodes.length % 4) * 280, y: Math.floor(value.flow.nodes.length / 4) * 200 }, data: { label: newType, type: newType, properties } }] } });
    selectNode(id); selectEdge('');
  };
  return <Stack spacing={2}>
    <TextField label={t('teams.flows.name')} value={value.flow.name} disabled={disabled}
      onChange={event => commit({ ...value, flow: { ...value.flow, name: event.target.value } })} />
    <TextField label={t('teams.flows.description')} multiline minRows={2} value={value.flow.description ?? ''} disabled={disabled}
      onChange={event => commit({ ...value, flow: { ...value.flow, description: event.target.value } })} />
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <TextField select size="small" label={t('teams.flows.stepType')} value={newType} onChange={event => setNewType(event.target.value as NodeType)} disabled={disabled} sx={{ minWidth: 150 }}>
        {sharedFlowNodeTypes.map(type => <MenuItem key={type} value={type}>{type}</MenuItem>)}
      </TextField><Button disabled={disabled} onClick={addNode}>{t('teams.flows.addStep')}</Button>
      <Button disabled={disabled || !history.current.length || Object.keys(propertyDrafts).length > 0} onClick={() => { const prior = history.current.pop(); if (prior) { future.current.push(value); onChange(prior); } }}>{t('flows.builder.undo')}</Button>
      <Button disabled={disabled || !future.current.length || Object.keys(propertyDrafts).length > 0} onClick={() => { const next = future.current.pop(); if (next) { history.current.push(value); onChange(next); } }}>{t('flows.builder.redo')}</Button>
      <Button color="error" disabled={disabled || (!current && !edge)} onClick={() => {
        commit({ ...value, flow: { ...value.flow, nodes: value.flow.nodes.filter(node => node.id !== selectedId),
          edges: value.flow.edges.filter(item => item.id !== selectedEdge && item.source !== selectedId && item.target !== selectedId) } });
        selectNode(''); selectEdge('');
      }}>{t('teams.flows.removeSelection')}</Button>
    </Stack>
    {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
    <Box sx={{ height: { xs: 400, md: 520 }, border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <FlowQuickConnectEnabledContext.Provider value={false}>
        <ReactFlow<FlowNode, Edge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView
          connectionMode={ConnectionMode.Loose} nodesDraggable={!disabled} nodesConnectable={!disabled} deleteKeyCode={disabled ? null : ['Backspace', 'Delete']}
          onNodeClick={(_event, node) => { selectNode(node.id); selectEdge(''); setNewProperty(''); }}
          onEdgeClick={(_event, item) => { selectEdge(item.id); selectNode(''); }}
          onNodesChange={changes => {
            const structural = changes.filter(change => !['select', 'dimensions'].includes(change.type));
            if (!structural.length) return;
            const updated = applyNodeChanges(structural, nodes).map(({ id, type, position, data }) => ({ id, type: type as NodeType, position, data: { ...data, type: data.type as NodeType, properties: data.properties ?? {} } }));
            const ids = new Set(updated.map(node => node.id));
            commit({ ...value, flow: { ...value.flow, nodes: updated, edges: value.flow.edges.filter(item => ids.has(item.source) && ids.has(item.target)) } });
          }}
          onEdgesChange={changes => {
            const removed = new Set(changes.filter(change => change.type === 'remove').map(change => change.id)); if (!removed.size) return;
            commit({ ...value, flow: { ...value.flow, edges: value.flow.edges.filter(item => !removed.has(item.id)) } });
          }}
          isValidConnection={connection => isConnectionAllowed({ ...connection, sourceHandle: connection.sourceHandle ?? null, targetHandle: connection.targetHandle ?? null }, nodes, edges)}
          onConnect={connection => {
            if (!isConnectionAllowed(connection, nodes, edges)) return;
            const created = createEdgeFromConnection(connection, nodes); const replaced = new Set(getReplacedEdgeIds(created, edges));
            // Presentation-only edge fields are not part of the shared format.
            const authored = { id: created.id, source: created.source, target: created.target, type: created.type as 'custom' | 'mcpEdge' | 'resourceEdge',
              sourceHandle: created.sourceHandle, targetHandle: created.targetHandle, data: created.data as SharedFlowDocument['flow']['edges'][number]['data'] };
            commit({ ...value, flow: { ...value.flow, edges: [...value.flow.edges.filter(item => !replaced.has(item.id)), authored] } });
          }}><Background /><Controls showInteractive={false} /></ReactFlow>
      </FlowQuickConnectEnabledContext.Provider>
    </Box>
    {current ? <Paper variant="outlined" sx={{ p: 2 }}><Stack spacing={2}>
      <Typography variant="h6">{t('teams.flows.selectedStep')}</Typography>
      <TextField label={t('teams.flows.stepLabel')} value={current.data.label} disabled={disabled} onChange={event => commit({ ...value, flow: { ...value.flow,
        nodes: value.flow.nodes.map(node => node.id === current.id ? { ...node, data: { ...node.data, label: event.target.value } } : node) } })} />
      {slots.map(slot => <Stack key={`${slot.property}:${slot.index ?? ''}`} spacing={1}><TextField select label={`${t('teams.flows.dependency')} · ${slot.kind}${slot.index === undefined ? '' : ` ${slot.index + 1}`}`}
        value={slot.value} disabled={disabled} onChange={event => commit(setFlowDependency(value, slot, event.target.value))} helperText={t('teams.flows.dependencyHelp')}>
        <MenuItem value="">{t('teams.flows.chooseDependency')}</MenuItem>
        {resources.filter(resource => resource.teamId === teamId && resource.kind === slot.kind && resource.format === `flujo.${slot.kind}.v1`)
          .map(resource => <MenuItem key={resource.id} value={teamDependencyId(slot.kind, teamId, resource.id)}>{resource.name} · v{resource.version}</MenuItem>)}
      </TextField><Button disabled={disabled} aria-label={`${t('teams.flows.removeProperty')}: ${slot.property}${slot.index === undefined ? '' : ` ${slot.index + 1}`}`} onClick={() => {
        const properties = { ...current.data.properties };
        if (slot.index === undefined) delete properties[slot.property];
        else properties[slot.property] = (properties[slot.property] as string[]).filter((_item, index) => index !== slot.index);
        updateProperties(properties);
      }}>{t('teams.flows.removeProperty')}</Button></Stack>)}
      {Object.entries(current.data.properties).filter(([key]) => !['boundModel', 'boundServer', 'subflowId', 'parallelSubflowIds'].includes(key)).map(([key, item]) => {
        const draftKey = `${current.id}:${key}`;
        const remove = <Button disabled={disabled} aria-label={`${t('teams.flows.removeProperty')}: ${key}`} onClick={() => {
          const properties = { ...current.data.properties }; delete properties[key]; updateProperties(properties);
        }}>{t('teams.flows.removeProperty')}</Button>;
        if (typeof item === 'boolean') return <Stack key={key} direction="row"><FormControlLabel label={key} control={<Checkbox disabled={disabled} checked={item} onChange={event => updateProperties({ ...current.data.properties, [key]: event.target.checked })} />} />{remove}</Stack>;
        return <Stack key={key} spacing={1}><TextField label={key} multiline minRows={2} disabled={disabled} value={propertyDrafts[draftKey] ?? (typeof item === 'string' ? item : JSON.stringify(item, null, 2))}
          onChange={event => {
            const raw = event.target.value;
            if (typeof item === 'string') updateProperties({ ...current.data.properties, [key]: raw }); else rawDraft(draftKey, raw);
          }} onBlur={() => {
            if (typeof item === 'string' || propertyDrafts[draftKey] === undefined) return;
            try { updateProperties({ ...current.data.properties, [key]: JSON.parse(propertyDrafts[draftKey]) }); rawDraft(draftKey); setError(''); }
            catch { setError(t('teams.flows.invalidProperty')); }
          }} />{remove}</Stack>;
      })}
      {Array.isArray(current.data.properties.parallelSubflowIds) && <Button disabled={disabled} onClick={() => updateProperties({ ...current.data.properties,
        parallelSubflowIds: [...current.data.properties.parallelSubflowIds as string[], ''] })}>{t('teams.flows.addDependency')}</Button>}
      <Stack direction="row" spacing={1}><TextField select label={t('teams.flows.property')} size="small" value={newProperty} onChange={event => setNewProperty(event.target.value)} disabled={disabled} sx={{ flex: 1 }}>
        {sharedFlowProperties(current.type).filter(key => !(key in current.data.properties)).map(key => <MenuItem key={key} value={key}>{key}</MenuItem>)}
      </TextField><Button disabled={disabled || !newProperty || !sharedFlowProperties(current.type).includes(newProperty)} onClick={() => {
        const initial = newProperty === 'temperature' ? 0.7 : ['parallelSubflowIds', 'enabledTools', 'allowedTools', 'entries'].includes(newProperty) ? []
          : /^(?:exclude|enable|allow|inject|include)|^(?:mapOverList|sequential)$/.test(newProperty) ? false
            : /^(?:maxTurns|maxTokens|thinkingBudget|contextWindow|compactionThreshold|compactionThresholdPercent|concurrencyLimit|toolTimeout|sessionTurnCap)$/.test(newProperty) ? 1 : '';
        updateProperties({ ...current.data.properties, [newProperty]: initial }); setNewProperty('');
      }}>{t('teams.flows.addProperty')}</Button></Stack>
    </Stack></Paper> : <Typography>{t('teams.flows.selectStep')}</Typography>}
    {edge && <FormControlLabel label={t('teams.flows.bidirectional')} control={<Checkbox checked={Boolean(edge.data?.bidirectional)} disabled={disabled || edge.type === 'mcpEdge' || edge.type === 'resourceEdge' || (!edge.data?.bidirectional && !canConvertToBidirectional(edge, nodes, edges))}
      onChange={event => commit({ ...value, flow: { ...value.flow, edges: value.flow.edges.map(item => item.id === edge.id ? { ...item, data: { ...item.data, bidirectional: event.target.checked } } : item) } })} />} />}
    {edge && <TextField label={t('teams.flows.condition')} multiline minRows={3} disabled={disabled || edge.type === 'mcpEdge' || edge.type === 'resourceEdge'}
      value={propertyDrafts[`edge:${edge.id}`] ?? JSON.stringify(edge.data?.condition ?? {}, null, 2)}
      onChange={event => rawDraft(`edge:${edge.id}`, event.target.value)} onBlur={() => {
        const raw = propertyDrafts[`edge:${edge.id}`]; if (raw === undefined) return;
        try {
          const condition = JSON.parse(raw); if (!condition || typeof condition !== 'object' || Array.isArray(condition)) throw new Error();
          commit({ ...value, flow: { ...value.flow, edges: value.flow.edges.map(item => item.id === edge.id ? { ...item, data: { ...item.data, condition } } : item) } });
          rawDraft(`edge:${edge.id}`); setError('');
        } catch { setError(t('teams.flows.invalidProperty')); }
      }} />}
  </Stack>;
}
