/** Assistive source evidence only; never installation or runtime authority. */
export interface McpSecurityReview {
  status: 'reviewed' | 'partial' | 'unsupported' | 'unavailable' | 'cancelled';
  message: string;
  source?: { repositoryUrl: string; revision: string; digest: string; fileCount: number; bytes: number };
  scanner?: { name: 'SkillSpector'; version: '2.12.0'; imageId: string; mode: 'static'; dependencyLookup: 'offline' };
  risk?: { score: number; severity: string };
  findings?: Array<{ severity: string; category: string; file: string; line?: number; message: string }>;
  limitations: string[];
}
