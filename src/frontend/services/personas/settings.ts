"use client";

import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import type {
  DeletePersonaInput,
  Persona,
  PersonaDeletionPreview,
  PersonaDeletionTombstone,
  PersonaExportPreview,
  PersonaExportSelection,
  PersonaSettingsOptions,
  UpdatePersonaInput,
} from '@/shared/types/enduringAgent';

import {
  PersonasApiError,
  type PersonaDetail,
} from './index';

const BASE = '/v1/personas';

function personaPath(personaId: string, suffix = ''): string {
  return `${BASE}/${encodeURIComponent(personaId)}${suffix}`;
}

async function apiError(response: Response): Promise<PersonasApiError> {
  const body = await response.json().catch(() => null) as {
    error?: unknown;
    code?: unknown;
    details?: unknown;
  } | null;
  const details = body?.details;
  return new PersonasApiError(
    response.status,
    typeof body?.error === 'string'
      ? body.error
      : `Persona request failed (HTTP ${response.status}).`,
    typeof body?.code === 'string' ? body.code : undefined,
    details !== null && typeof details === 'object' && !Array.isArray(details)
      ? details as Record<string, unknown>
      : undefined,
  );
}

async function json<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(withWorkspaceUrl(path), {
    method,
    headers: body === undefined
      ? undefined
      : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw await apiError(response);
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

function attachmentFilename(response: Response): string {
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = disposition.match(/filename="([^"]+)"/i);
  return match?.[1] ?? 'persona-configuration.flujo.json';
}

export const personaSettingsService = {
  options(): Promise<PersonaSettingsOptions> {
    return json<PersonaSettingsOptions>(`${BASE}/settings-options`);
  },
  get(personaId: string): Promise<PersonaDetail> {
    return json<PersonaDetail>(personaPath(personaId));
  },
  update(personaId: string, input: UpdatePersonaInput): Promise<Persona> {
    return json<Persona>(personaPath(personaId), 'PATCH', input);
  },
  exportPreview(
    personaId: string,
    selection: PersonaExportSelection,
  ): Promise<PersonaExportPreview> {
    return json<PersonaExportPreview>(
      personaPath(personaId, '/export-preview'),
      'POST',
      selection,
    );
  },
  async exportConfiguration(
    personaId: string,
    selection: PersonaExportSelection,
  ): Promise<{ blob: Blob; filename: string; sha256?: string }> {
    const response = await fetch(
      withWorkspaceUrl(personaPath(personaId, '/export')),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selection),
      },
    );
    if (!response.ok) throw await apiError(response);
    return {
      blob: await response.blob(),
      filename: attachmentFilename(response),
      sha256: response.headers.get('X-Content-SHA256') ?? undefined,
    };
  },
  deletionPreview(personaId: string): Promise<PersonaDeletionPreview> {
    return json<PersonaDeletionPreview>(
      personaPath(personaId, '/deletion-preview'),
    );
  },
  delete(
    personaId: string,
    input: DeletePersonaInput,
  ): Promise<PersonaDeletionTombstone> {
    return json<PersonaDeletionTombstone>(
      personaPath(personaId),
      'DELETE',
      input,
    );
  },
};
