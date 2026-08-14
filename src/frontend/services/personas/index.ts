"use client";

import type {
  ActivateBehaviorRevisionInput,
  AssignPersonaWorkItemInput,
  AssignPersonaWorkItemResult,
  BehaviorBinding,
  BehaviorProposal,
  BehaviorRevision,
  CopyPersonaFlowInput,
  CopyPersonaFlowResult,
  CreatePersonaCreationDraftInput,
  CreatePersonaInput,
  CreatePersonaWorkItemInput,
  DeletePersonaCreationDraftInput,
  MemoryItem,
  Persona,
  PersonaActivity,
  PersonaAppGrant,
  PersonaAppLaunchDescriptor,
  PersonaComposition,
  PersonaFlowReadiness,
  PersonaMailboxItem,
  PersonaNativeAbilityId,
  PersonaPresentationSummary,
  PersonaCreationDraft,
  PersonaWorkItem,
  RoleDefinition,
  RoleVersion,
  UpdatePersonaCompositionInput,
  UpdatePersonaCreationDraftInput,
  UpdatePersonaInput,
  UpdatePersonaWorkItemInput,
} from '@/shared/types/enduringAgent';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';

const BASE = '/v1/personas';
const DRAFT_BASE = '/v1/persona-drafts';

export class PersonasApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PersonasApiError';
  }
}

export interface PersonaRuntimeProjection {
  personaId: string;
  lifecycleState: Persona['lifecycleState'];
  mailbox: {
    queued: number;
    ready: number;
    delayed: number;
    claimed: number;
    coalesced: number;
    completed: number;
    rejected: number;
  };
  activities: { running: number; waiting: number; terminal: number };
  active: null | { activityId: string; kind: PersonaActivity['kind']; expiresAt: number };
  waitingActivityIds: string[];
  leaseStatus: 'none' | 'active' | 'released' | 'expired';
  stuck: boolean;
  stuckIndicators: string[];
}

export interface PersonaDetail {
  persona: Persona;
  roleVersion: RoleVersion;
  behaviorBindings: BehaviorBinding[];
  behaviorRevisions: BehaviorRevision[];
  appGrants: PersonaAppGrant[];
  memoryItems: MemoryItem[];
  workItems: PersonaWorkItem[];
  activities: PersonaActivity[];
  mailboxItems: PersonaMailboxItem[];
  lease: {
    workspaceId: string;
    personaId: string;
    activityId: string;
    fencingToken: number;
    status: 'active' | 'released' | 'expired';
    acquiredAt: number;
    renewedAt: number;
    expiresAt: number;
    releasedAt?: number;
  } | null;
  runtime: {
    projection: PersonaRuntimeProjection;
    detectedStuckIndicators: string[];
    reconciliation: { attempted: boolean; changed: boolean; remainingStuck: boolean };
    recentEvents: Array<Record<string, unknown>>;
  };
  presentation: PersonaPresentationSummary;
}

export interface PersonaExecutionPreview {
  personaId: string;
  coreFlowRef?: string;
  apps: string[];
  behaviors: Array<{
    slotKey: string;
    name: string;
    description?: string;
  }>;
  nativeAbilities: PersonaNativeAbilityId[];
  readOnly: true;
}

export type PersonaWorkItemControlAction =
  | 'pause'
  | 'stop'
  | 'retry'
  | 'move_earlier'
  | 'move_later';

export interface PersonaWorkItemControlResult {
  action: PersonaWorkItemControlAction;
  workItem: PersonaWorkItem;
  admission?: AssignPersonaWorkItemResult['admission'];
  moved?: boolean;
}

export interface PromotePersonaImprovementInput {
  confirmation: 'PROMOTE';
  migrationNotes: string;
}

export interface PromotePersonaImprovementResult {
  proposal: BehaviorProposal;
  roleVersion: RoleVersion;
}

export type PersonaBundle = Omit<PersonaDetail, 'runtime' | 'presentation'>;

export interface MemorySearchResult {
  item: MemoryItem;
  score: number;
  core: boolean;
}

export interface PersonaMemoryAvailabilityInput {
  validFrom?: number;
  validUntil?: number;
}

export interface RolesResponse {
  roleDefinitions: RoleDefinition[];
  roleVersions: RoleVersion[];
}

export interface StartPersonaConversationInput {
  id: string;
  title: string;
  flowId: null;
  personaTargetId: string;
  createdAt: number;
  updatedAt: number;
}

async function parse<T>(response: Response | Promise<Response>): Promise<T> {
  response = await response;
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => null) as {
    error?: unknown;
    code?: unknown;
    details?: unknown;
  } | null;
  if (!response.ok) {
    const details = body?.details;
    throw new PersonasApiError(
      response.status,
      typeof body?.error === 'string' ? body.error : `Persona request failed (HTTP ${response.status}).`,
      typeof body?.code === 'string' ? body.code : undefined,
      details !== null && typeof details === 'object' && !Array.isArray(details)
        ? details as Record<string, unknown>
        : undefined,
    );
  }
  return body as T;
}

function personaPath(personaId: string, suffix = ''): string {
  return `${BASE}/${encodeURIComponent(personaId)}${suffix}`;
}

function draftPath(draftId: string): string {
  return `${DRAFT_BASE}/${encodeURIComponent(draftId)}`;
}

async function jsonRequest<T>(path: string, method: string, body?: unknown): Promise<T> {
  return parse<T>(await fetch(withWorkspaceUrl(path), {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

class PersonasService {
  list(): Promise<Persona[]> {
    return parse(fetch(withWorkspaceUrl(BASE)));
  }

  get(personaId: string): Promise<PersonaDetail> {
    return parse(fetch(withWorkspaceUrl(personaPath(personaId))));
  }

  executionPreview(personaId: string): Promise<PersonaExecutionPreview> {
    return parse(fetch(withWorkspaceUrl(personaPath(personaId, '/execution-preview'))));
  }

  create(input: CreatePersonaInput): Promise<PersonaBundle> {
    return jsonRequest(BASE, 'POST', input);
  }

  listDrafts(): Promise<PersonaCreationDraft[]> {
    return parse(fetch(withWorkspaceUrl(DRAFT_BASE)));
  }

  getDraft(draftId: string): Promise<PersonaCreationDraft> {
    return parse(fetch(withWorkspaceUrl(draftPath(draftId))));
  }

  createDraft(input: CreatePersonaCreationDraftInput): Promise<PersonaCreationDraft> {
    return jsonRequest(DRAFT_BASE, 'POST', input);
  }

  updateDraft(
    draftId: string,
    input: UpdatePersonaCreationDraftInput,
  ): Promise<PersonaCreationDraft> {
    return jsonRequest(draftPath(draftId), 'PATCH', input);
  }

  deleteDraft(draftId: string, input: DeletePersonaCreationDraftInput): Promise<void> {
    return jsonRequest(draftPath(draftId), 'DELETE', input);
  }

  update(personaId: string, input: UpdatePersonaInput): Promise<Persona> {
    return jsonRequest(personaPath(personaId), 'PATCH', input);
  }

  getComposition(personaId: string): Promise<PersonaComposition> {
    return parse(fetch(withWorkspaceUrl(personaPath(personaId, '/composition'))));
  }

  updateComposition(
    personaId: string,
    input: UpdatePersonaCompositionInput,
  ): Promise<PersonaComposition> {
    return jsonRequest(personaPath(personaId, '/composition'), 'PATCH', input);
  }

  copyCompositionFlow(
    personaId: string,
    input: CopyPersonaFlowInput,
  ): Promise<CopyPersonaFlowResult> {
    return jsonRequest(personaPath(personaId, '/composition/copy'), 'POST', input);
  }

  roles(signal?: AbortSignal): Promise<RolesResponse> {
    return parse(fetch(withWorkspaceUrl('/v1/roles'), { signal }));
  }

  flowReadiness(flowRef: string): Promise<PersonaFlowReadiness> {
    return parse(fetch(withWorkspaceUrl(
      `/v1/flows/${encodeURIComponent(flowRef)}/readiness`,
    )));
  }

  startConversation(input: StartPersonaConversationInput): Promise<{ id: string }> {
    return jsonRequest('/v1/chat/conversations', 'POST', input);
  }

  memories(personaId: string, query?: string): Promise<MemorySearchResult[]> {
    const params = new URLSearchParams({
      status: 'candidate,active,superseded,forgotten',
      limit: '200',
    });
    if (query?.trim()) params.set('q', query.trim());
    return parse(fetch(withWorkspaceUrl(`${personaPath(personaId, '/memories')}?${params}`)));
  }

  createMemory(
    personaId: string,
    input: { content: string; requestId: string } & PersonaMemoryAvailabilityInput,
  ): Promise<MemoryItem> {
    const observedAt = Date.now();
    return jsonRequest(personaPath(personaId, '/memories'), 'POST', {
      id: input.requestId,
      personaId,
      kind: 'semantic',
      scope: 'persona',
      content: input.content,
      confidence: 1,
      importance: 0.5,
      status: 'active',
      trust: 'explicit_user',
      ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
      sourceRefs: [{
        kind: 'user_statement',
        id: `persona-desk-create-${input.requestId}`,
        observedAt,
      }],
    });
  }

  activateMemory(personaId: string, memoryId: string): Promise<MemoryItem> {
    return jsonRequest(personaPath(
      personaId,
      `/memories/${encodeURIComponent(memoryId)}/activate`,
    ), 'POST');
  }

  correctMemory(
    personaId: string,
    memory: MemoryItem,
    content: string,
    availability: PersonaMemoryAvailabilityInput = {
      validFrom: memory.validFrom,
      validUntil: memory.validUntil,
    },
  ): Promise<MemoryItem> {
    return jsonRequest(personaPath(
      personaId,
      `/memories/${encodeURIComponent(memory.id)}/correct`,
    ), 'POST', {
      content,
      confidence: memory.confidence,
      importance: memory.importance,
      ...(availability.validFrom !== undefined ? { validFrom: availability.validFrom } : {}),
      ...(availability.validUntil !== undefined ? { validUntil: availability.validUntil } : {}),
      sourceRefs: [{
        kind: 'user_statement',
        id: `persona-desk-correction-${memory.id}`,
        observedAt: Date.now(),
      }],
      expectedUpdatedAt: memory.updatedAt,
    });
  }

  forgetMemory(personaId: string, memoryId: string): Promise<MemoryItem> {
    return jsonRequest(personaPath(
      personaId,
      `/memories/${encodeURIComponent(memoryId)}`,
    ), 'DELETE');
  }

  pinMemory(personaId: string, memoryId: string, pin: boolean): Promise<MemoryItem[]> {
    return jsonRequest(personaPath(
      personaId,
      `/memories/${encodeURIComponent(memoryId)}/pin`,
    ), pin ? 'POST' : 'DELETE');
  }

  createWorkItem(personaId: string, input: Omit<CreatePersonaWorkItemInput, 'personaId'>): Promise<PersonaWorkItem> {
    return jsonRequest(personaPath(personaId, '/work-items'), 'POST', input);
  }

  assignWorkItem(
    personaId: string,
    workItemId: string,
    input: AssignPersonaWorkItemInput,
  ): Promise<AssignPersonaWorkItemResult> {
    return jsonRequest(personaPath(
      personaId,
      `/work-items/${encodeURIComponent(workItemId)}/assign`,
    ), 'POST', input);
  }

  controlWorkItem(
    personaId: string,
    workItemId: string,
    action: PersonaWorkItemControlAction,
  ): Promise<PersonaWorkItemControlResult> {
    return jsonRequest(personaPath(
      personaId,
      `/work-items/${encodeURIComponent(workItemId)}/control`,
    ), 'POST', { action });
  }

  updateWorkItem(
    personaId: string,
    workItemId: string,
    input: UpdatePersonaWorkItemInput,
  ): Promise<PersonaWorkItem> {
    return jsonRequest(personaPath(
      personaId,
      `/work-items/${encodeURIComponent(workItemId)}`,
    ), 'PATCH', input);
  }

  deleteWorkItem(personaId: string, workItemId: string): Promise<void> {
    return jsonRequest(personaPath(
      personaId,
      `/work-items/${encodeURIComponent(workItemId)}`,
    ), 'DELETE');
  }

  activateBehavior(
    personaId: string,
    behaviorId: string,
    input: ActivateBehaviorRevisionInput,
  ): Promise<{ binding: BehaviorBinding; revision: BehaviorRevision }> {
    return jsonRequest(personaPath(
      personaId,
      `/behaviors/${encodeURIComponent(behaviorId)}/activate`,
    ), 'POST', input);
  }

  improvements(personaId: string): Promise<BehaviorProposal[]> {
    return parse(fetch(withWorkspaceUrl(personaPath(personaId, '/improvements'))));
  }

  applyImprovement(personaId: string, proposalId: string): Promise<BehaviorProposal> {
    return jsonRequest(personaPath(
      personaId,
      `/improvements/${encodeURIComponent(proposalId)}/apply`,
    ), 'POST');
  }

  rejectImprovement(personaId: string, proposalId: string): Promise<BehaviorProposal> {
    return jsonRequest(personaPath(
      personaId,
      `/improvements/${encodeURIComponent(proposalId)}/reject`,
    ), 'POST');
  }

  undoImprovement(personaId: string, proposalId: string): Promise<BehaviorProposal> {
    return jsonRequest(personaPath(
      personaId,
      `/improvements/${encodeURIComponent(proposalId)}/undo`,
    ), 'POST');
  }

  promoteImprovement(
    personaId: string,
    proposalId: string,
    input: PromotePersonaImprovementInput,
  ): Promise<PromotePersonaImprovementResult> {
    return jsonRequest(personaPath(
      personaId,
      `/improvements/${encodeURIComponent(proposalId)}/promote`,
    ), 'POST', input);
  }

  grantApp(personaId: string, mcpServerName: string): Promise<PersonaAppGrant> {
    return jsonRequest(personaPath(personaId, '/app-grants'), 'POST', { mcpServerName });
  }

  revokeApp(personaId: string, grantId: string): Promise<void> {
    return jsonRequest(personaPath(
      personaId,
      `/app-grants/${encodeURIComponent(grantId)}`,
    ), 'DELETE');
  }

  replaceApp(
    personaId: string,
    grantId: string,
    mcpServerName: string,
    expectedUpdatedAt: number,
  ): Promise<PersonaAppGrant> {
    return jsonRequest(personaPath(
      personaId,
      `/app-grants/${encodeURIComponent(grantId)}`,
    ), 'PATCH', { mcpServerName, expectedUpdatedAt });
  }

  authorizeAppLaunch(
    personaId: string,
    grantId: string,
    uri: string,
  ): Promise<PersonaAppLaunchDescriptor> {
    return jsonRequest(personaPath(
      personaId,
      `/app-grants/${encodeURIComponent(grantId)}/launch`,
    ), 'POST', { uri });
  }

  recoverRuntime(personaId: string): Promise<unknown> {
    return jsonRequest(personaPath(personaId, '/runtime-recovery'), 'POST', {
      confirmation: 'RECOVER',
    });
  }
}

export const personasService = new PersonasService();
