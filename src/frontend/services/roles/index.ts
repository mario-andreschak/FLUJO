'use client';

import type {
  CreatePublicRoleInput,
  DuplicatePublicRoleInput,
  PublicRole,
  PublicRoleVersion,
  RestorePublicRoleInput,
  RoleImpactPreview,
  RollbackPublicRoleInput,
  UpdatePublicRoleInput,
} from '@/shared/types/enduringAgent';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';

const BASE = '/v1/roles';

export class RolesApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RolesApiError';
  }
}

async function request<T>(
  path: string,
  method: string = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(withWorkspaceUrl(path), {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new RolesApiError(
      response.status,
      typeof payload?.error === 'string'
        ? payload.error
        : `Role request failed (HTTP ${response.status}).`,
      payload?.details,
    );
  }
  return payload as T;
}

class RolesService {
  list(includeArchived = false): Promise<{ roles: PublicRole[] }> {
    return request(`${BASE}${includeArchived ? '?includeArchived=true' : ''}`);
  }

  get(roleId: string): Promise<PublicRole> {
    return request(`${BASE}/${encodeURIComponent(roleId)}`);
  }

  create(input: CreatePublicRoleInput): Promise<PublicRole> {
    return request(BASE, 'POST', input);
  }

  update(roleId: string, input: UpdatePublicRoleInput): Promise<PublicRole> {
    return request(`${BASE}/${encodeURIComponent(roleId)}`, 'PATCH', input);
  }

  duplicate(roleId: string, input: DuplicatePublicRoleInput = {}): Promise<PublicRole> {
    return request(`${BASE}/${encodeURIComponent(roleId)}/duplicate`, 'POST', input);
  }

  archive(roleId: string, expectedCurrentVersionId: string): Promise<PublicRole> {
    return request(`${BASE}/${encodeURIComponent(roleId)}`, 'DELETE', {
      expectedCurrentVersionId,
      action: 'archive',
    });
  }

  restore(roleId: string, input: RestorePublicRoleInput): Promise<PublicRole> {
    return request(`${BASE}/${encodeURIComponent(roleId)}/restore`, 'POST', input);
  }

  remove(roleId: string, expectedCurrentVersionId: string): Promise<void> {
    return request(`${BASE}/${encodeURIComponent(roleId)}`, 'DELETE', {
      expectedCurrentVersionId,
      action: 'delete',
    });
  }

  versions(roleId: string): Promise<{ versions: PublicRoleVersion[] }> {
    return request(`${BASE}/${encodeURIComponent(roleId)}/versions`);
  }

  rollback(roleId: string, input: RollbackPublicRoleInput): Promise<PublicRole> {
    return request(`${BASE}/${encodeURIComponent(roleId)}/rollback`, 'POST', input);
  }

  impact(roleId: string): Promise<RoleImpactPreview> {
    return request(`${BASE}/${encodeURIComponent(roleId)}/impact`);
  }
}

export const rolesService = new RolesService();
