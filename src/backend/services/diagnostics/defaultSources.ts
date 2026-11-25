import os from 'node:os';
import applicationPackage from '../../../../package.json';
import { getInstallMode } from '@/utils/paths';
import { getExposureMode } from '@/utils/http/exposureMode';
import { getEncryptionStatus } from '@/utils/encryption/secure';
import { modelService } from '@/backend/services/model';
import { mcpService } from '@/backend/services/mcp';
import { flowService } from '@/backend/services/flow';
import { getSchedulerService } from '@/backend/services/scheduler';
import { aggregateStatistics } from '@/backend/services/statistics/aggregation';
import { readWithin, type DiagnosticReaders } from './report';

/** A slow app is shown as `unknown` so the whole apps section still fits its own wait. */
const APP_STATE_WAIT_MS = 3_000;

/** The live sections of this installation and the current workspace. */
export const defaultDiagnosticReaders: DiagnosticReaders = {
  app: () => ({ version: applicationPackage.version, installMode: getInstallMode() }),
  system: () => ({
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    cpuCores: os.availableParallelism(),
    totalMemoryBytes: os.totalmem(),
  }),
  security: async () => ({
    exposureMode: getExposureMode(),
    ownerLogin: process.env.FLUJO_OWNER_AUTH_FILE !== undefined,
    protection: (await getEncryptionStatus()).protection,
  }),
  models: async () => {
    const result = await modelService.listModels();
    if (!result.success || !result.models) throw new Error('Models are unavailable');
    return result.models;
  },
  apps: async () => {
    const configs = await mcpService.loadServerConfigs();
    if (!Array.isArray(configs)) throw new Error('Connected apps are unavailable');
    return Promise.all(configs.map(async config => ({
      transport: config.transport,
      disabled: config.disabled,
      state: config.disabled ? 'disabled' : (await readWithin(() => mcpService.getServerStatus(config.name), APP_STATE_WAIT_MS))?.status,
    })));
  },
  flows: () => flowService.loadFlows(),
  automations: async () => (await getSchedulerService().list()).map(({ execution, lastRun }) => ({
    enabled: execution.enabled,
    triggerType: execution.trigger?.type,
    lastRunStatus: lastRun?.status,
  })),
  activity: async range => {
    const { summary, daily } = await aggregateStatistics({ range });
    return { ...range, summary, daily };
  },
};
