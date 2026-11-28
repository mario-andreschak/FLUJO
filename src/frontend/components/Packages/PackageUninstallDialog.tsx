"use client";

import React, { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import {
  FlowUseRows,
  flowCandidates,
  flowPausedPersonas,
  flowPlanFromChoices,
  initialFlowChoices,
} from '@/frontend/components/Flow/FlowDashboard/FlowDeleteDialog';
import {
  McpServerUseRows,
  serverCandidates,
  serverPlanFromChoices,
  serverRemovedPlaces,
  type McpServerChoice,
} from '@/frontend/components/mcp/MCPServerManager/McpServerDeleteDialog';
import type { Flow } from '@/frontend/types/flow/flow';
import type { DeletePlan } from '@/shared/types/deletePlan';
import type { PackageUninstallPlan, PackageUsage } from '@/shared/types/package/uninstall';

/**
 * Asks what happens to each place outside a package that still uses one of
 * its agents or Connected Apps before the package is removed (#1389), with the
 * same choices as deleting one agent or app.
 */
export interface PackageUninstallDialogProps {
  usage: PackageUsage | null;
  flows: Flow[];
  servers: McpServerChoice[];
  busy: boolean;
  error: string | null;
  notice: string | null;
  onCancel: () => void;
  onConfirm: (plan: PackageUninstallPlan) => void;
}

type ChoicesById = Record<string, Record<string, string>>;

function UninstallChoices({ usage, flows, servers, busy, error, notice, onCancel, onConfirm }: PackageUninstallDialogProps & { usage: PackageUsage }) {
  const { t, formatList } = useI18n();
  const flowOptions = useMemo(() => flowCandidates(flows, usage.leaving.flowIds), [flows, usage.leaving.flowIds]);
  const serverOptions = useMemo(() => serverCandidates(servers, usage.leaving.serverNames), [servers, usage.leaving.serverNames]);
  const [flowChoices, setFlowChoices] = useState<ChoicesById>(() => Object.fromEntries(
    usage.flows.map((flow) => [flow.flowId, initialFlowChoices(flow, flowOptions)]),
  ));
  const [serverChoices, setServerChoices] = useState<ChoicesById>({});

  const plan = useMemo((): PackageUninstallPlan | null => {
    const flowPlans: Record<string, DeletePlan> = {};
    for (const flow of usage.flows) {
      const answers = flowPlanFromChoices(flow, flowChoices[flow.flowId] ?? {});
      if (!answers) return null;
      flowPlans[flow.flowId] = answers;
    }
    const serverPlans: Record<string, DeletePlan> = {};
    for (const server of usage.servers) {
      const answers = serverPlanFromChoices(server, serverChoices[server.serverName] ?? {});
      if (!answers) return null;
      serverPlans[server.serverName] = answers;
    }
    return { flows: flowPlans, servers: serverPlans };
  }, [flowChoices, serverChoices, usage]);

  const paused = [...new Set(usage.flows.flatMap((flow) => flowPausedPersonas(flow, flowChoices[flow.flowId] ?? {})))];
  const losingApps = [...new Set(usage.servers.flatMap((server) => serverRemovedPlaces(server, serverChoices[server.serverName] ?? {})))];
  const choose = (setter: typeof setFlowChoices, id: string) => (key: string, value: string) => setter((current) => ({
    ...current,
    [id]: { ...(current[id] ?? {}), [key]: value },
  }));

  return (
    <>
      <DialogTitle>{t('packages.installed.confirmTitle', { name: usage.packageName })}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {notice && <Alert severity="info" role="status">{notice}</Alert>}
          <Typography color="text.secondary">{t('packages.uninstall.inUseIntro')}</Typography>
          {usage.flows.map((flow) => (
            <Stack key={`flow:${flow.flowId}`} spacing={1.5} component="section" aria-label={t('packages.uninstall.agent', { name: flow.flowName })}>
              <Typography variant="subtitle2" component="h3">{t('packages.uninstall.agent', { name: flow.flowName })}</Typography>
              <FlowUseRows
                usage={flow}
                candidates={flowOptions}
                choices={flowChoices[flow.flowId] ?? {}}
                disabled={busy}
                onChange={choose(setFlowChoices, flow.flowId)}
              />
            </Stack>
          ))}
          {usage.servers.map((server) => (
            <Stack key={`app:${server.serverName}`} spacing={1.5} component="section" aria-label={t('packages.uninstall.app', { name: server.serverName })}>
              <Typography variant="subtitle2" component="h3">{t('packages.uninstall.app', { name: server.serverName })}</Typography>
              <McpServerUseRows
                usage={server}
                candidates={serverOptions}
                choices={serverChoices[server.serverName] ?? {}}
                disabled={busy}
                onChange={choose(setServerChoices, server.serverName)}
              />
            </Stack>
          ))}
          {paused.length > 0 && (
            <Alert severity="warning" role="status">{t('flows.delete.pauseWarning', { names: formatList(paused) })}</Alert>
          )}
          {losingApps.length > 0 && (
            <Alert severity="warning" role="status">{t('mcp.delete.removeWarning', { names: formatList(losingApps) })}</Alert>
          )}
          {error && <Alert severity="error" role="alert">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>{t('packages.installed.cancel')}</Button>
        <Button
          color="error"
          variant="contained"
          disabled={busy || !plan}
          onClick={() => plan && onConfirm(plan)}
          startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {t('packages.installed.uninstall')}
        </Button>
      </DialogActions>
    </>
  );
}

const PackageUninstallDialog = (props: PackageUninstallDialogProps) => {
  const { usage, busy, onCancel } = props;
  // Fresh answers whenever the places themselves change; a refresh with the same places keeps them.
  const placesKey = usage
    ? [...usage.flows.flatMap((flow) => flow.uses.map((use) => `${flow.flowId}/${use.key}`)),
      ...usage.servers.flatMap((server) => server.uses.map((use) => `${server.serverName}/${use.key}`))].join('|')
    : '';
  return (
    <Dialog open={usage !== null} onClose={busy ? undefined : onCancel} fullWidth maxWidth="sm">
      {usage && <UninstallChoices key={`${usage.packageName}:${placesKey}`} {...props} usage={usage} />}
    </Dialog>
  );
};

export default PackageUninstallDialog;
