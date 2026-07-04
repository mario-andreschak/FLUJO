import {
  PlannedExecution,
  PlannedExecutionStatus,
  RunRecord,
} from '@/shared/types/plannedExecution';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/services/plannedExecutions');

export interface PlannedExecutionListEntry {
  execution: PlannedExecution;
  status: PlannedExecutionStatus;
  lastRun: RunRecord | null;
}

export interface PlannedExecutionListResponse {
  paused: boolean;
  executions: PlannedExecutionListEntry[];
}

export type PlannedExecutionInput = Omit<
  PlannedExecution,
  'id' | 'createdAt' | 'updatedAt'
>;

/**
 * Frontend service for the Planned Executions REST API.
 * Follows the flowService singleton pattern: list reads swallow errors and
 * return empty data; mutations return { success, error }.
 */
class PlannedExecutionsService {
  async list(): Promise<PlannedExecutionListResponse> {
    try {
      const response = await fetch('/api/planned-executions');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      log.warn('Failed to list planned executions', error);
      return { paused: false, executions: [] };
    }
  }

  async create(
    input: PlannedExecutionInput
  ): Promise<{ success: boolean; execution?: PlannedExecution; error?: string }> {
    try {
      const response = await fetch('/api/planned-executions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = await response.json();
      if (!response.ok) {
        return { success: false, error: body?.error || `HTTP ${response.status}` };
      }
      return { success: true, execution: body.execution };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Request failed' };
    }
  }

  async update(
    id: string,
    patch: Partial<PlannedExecutionInput>
  ): Promise<{ success: boolean; execution?: PlannedExecution; error?: string }> {
    try {
      const response = await fetch(`/api/planned-executions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await response.json();
      if (!response.ok) {
        return { success: false, error: body?.error || `HTTP ${response.status}` };
      }
      return { success: true, execution: body.execution };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Request failed' };
    }
  }

  async delete(id: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(`/api/planned-executions/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        return { success: false, error: body?.error || `HTTP ${response.status}` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Request failed' };
    }
  }

  async setPaused(paused: boolean): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch('/api/planned-executions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        return { success: false, error: body?.error || `HTTP ${response.status}` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Request failed' };
    }
  }

  async runNow(id: string): Promise<{ success: boolean; record?: RunRecord; error?: string }> {
    try {
      const response = await fetch(`/api/planned-executions/${id}/run`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) {
        return { success: false, error: body?.error || `HTTP ${response.status}` };
      }
      return { success: true, record: body.record };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Request failed' };
    }
  }

  async loadRuns(id: string): Promise<RunRecord[]> {
    try {
      const response = await fetch(`/api/planned-executions/${id}/runs`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const body = await response.json();
      return Array.isArray(body?.runs) ? body.runs : [];
    } catch (error) {
      log.warn(`Failed to load runs for ${id}`, error);
      return [];
    }
  }

  async previewSchedule(
    cron: string,
    timezone?: string
  ): Promise<{ valid: boolean; error?: string; nextRuns: string[] }> {
    try {
      const response = await fetch('/api/planned-executions/preview-schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cron, timezone }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Preview failed',
        nextRuns: [],
      };
    }
  }
}

export const plannedExecutionsService = new PlannedExecutionsService();
