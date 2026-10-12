import type { Model } from '@/shared/types/model';
import { resolveModelAdapter } from '@/shared/types/model/provider';

/** A repository prompt must never reach an agent or a dedicated media route. */
export function supportsMcpModelRiskAssessment(model: Model): boolean {
  const adapter = resolveModelAdapter(model.provider, model.adapter);
  const outputs = (model.outputModalities ?? []).filter(value => typeof value === 'string').map(value => value.trim().toLowerCase());
  return !model.fallbackPolicy && ['openai', 'openai-responses', 'azure', 'anthropic', 'gemini'].includes(adapter)
    && (!outputs.length || outputs.every(value => value === 'text'));
}

export interface McpModelRiskEvidence {
  repositoryUrl: string;
  revision: string;
  capturedAt: string;
  evidenceDigest: string;
  repository: {
    stars: number | null;
    forks: number | null;
    lastCommitAt: string | null;
    openIssues: number | null;
    closedIssues: number | null;
    openIssueRatio: number | null;
  };
  author: {
    login: string;
    type: 'User' | 'Organization' | 'unknown';
    followers: number | null;
    publicRepositories: number | null;
    createdAt: string | null;
    accountAgeDays: number | null;
  };
  files: Array<{ path: string; blobSha: string; excerptDigest: string; bytes: number; text: string; truncated: boolean }>;
  limitations: Array<'signalsOnly' | 'sampleOnly' | 'sourceUnavailable' | 'sourceTruncated' | 'authorUnavailable' | 'issuesUnavailable' | 'repositorySignalsUnavailable'>;
}

export interface McpModelRiskAssessment {
  status: 'assessed' | 'unavailable' | 'unsupported' | 'cancelled';
  reason?: 'busy' | 'model' | 'credentials' | 'github' | 'response' | 'timeout';
  source?: Omit<McpModelRiskEvidence, 'files'> & { fileCount: number; bytes: number };
  model?: { id: string; name: string };
  assessment?: { score: number; rationale: string; flags: string[] };
}
