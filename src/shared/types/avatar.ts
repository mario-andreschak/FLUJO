/** Secret-free facts about the machine hosting Flujo, never the browser's login. */
export interface AvatarConnectionCandidate {
  id: string;
  kind: 'codex-subscription' | 'claude-subscription' | 'saved-model';
  label: string;
  host: 'flujo-server';
  runtime: 'available' | 'missing' | 'unknown';
  authentication: 'configured' | 'login-detected' | 'needs-connection' | 'incompatible' | 'unknown';
  verification: 'untested';
  nextAction: 'use-and-test' | 'sign-in' | 'connect-token' | 'repair' | 'manual';
  reasonCode?: string;
  modelId?: string;
  modelChoices: Array<{ id: string; label: string; source: 'saved' | 'fallback' }>;
}

export interface AvatarConnectionDiscovery {
  host: 'flujo-server';
  platform: string;
  checkedAt: number;
  candidates: AvatarConnectionCandidate[];
}

export interface AvatarWorldObject {
  id: string;
  name: string;
  kind: 'flow' | 'app' | 'persona' | 'automation' | 'meeting';
  state: string;
  href: string;
}

export interface AvatarWorldSnapshot {
  checkedAt: number;
  workModel: { modelId: string; label: string; verifiedAt: number; ready: boolean } | null;
  objects: AvatarWorldObject[];
  unavailable: string[];
  truncated: string[];
}
