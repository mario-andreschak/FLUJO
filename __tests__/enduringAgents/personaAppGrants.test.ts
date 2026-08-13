const loadServerConfigsMock = jest.fn();

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: (...args: unknown[]) => loadServerConfigsMock(...args),
}));

import {
  PersonaDomainConflictError,
  PersonaDomainNotFoundError,
  authorizePersonaAppLaunch,
  claimNextPersonaActivity,
  createPersonaFromRole,
  deletePersona,
  grantPersonaAppAccess,
  listPersonaDirectAppGrants,
  replacePersonaAppAccess,
  revokePersonaAppAccess,
  routePersonaMailboxItem,
  previewPersonaDeletion,
} from '@/backend/services/enduringAgents';
import {
  getPersonaAppGrant,
  listPersonaBundle,
} from '@/backend/services/enduringAgents/store';
import type { MCPServerConfig } from '@/shared/types/mcp';
import { runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

function inFreshWorkspace<T>(task: () => T): T {
  workspaceSequence += 1;
  return runWithWorkspace(`enduring-phase6-${process.pid}-${workspaceSequence}`, task);
}

function appConfig(
  name: string,
  options: { disabled?: boolean; enableMcpApps?: boolean } = {},
): MCPServerConfig {
  return {
    name,
    transport: 'stdio',
    command: 'node',
    args: [],
    disabled: options.disabled ?? false,
    enableMcpApps: options.enableMcpApps ?? true,
    autoApprove: [],
    rootPath: '',
    env: {},
    _buildCommand: '',
    _installCommand: '',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  loadServerConfigsMock.mockResolvedValue([
    appConfig('github-jim'),
    appConfig('github-sarah'),
    appConfig('disabled-app', { disabled: true }),
    appConfig('tools-only', { enableMcpApps: false }),
  ]);
});

describe('issue #415 phase 6 Persona direct-app grants', () => {
  it('persists an exact config identity and leaves Behavior tool authority unchanged', async () => {
    await inFreshWorkspace(async () => {
      const created = await createPersonaFromRole({
        name: 'Jim',
        idempotencyKey: 'phase6-jim',
      });
      const before = await listPersonaBundle(created.persona.id);

      const grant = await grantPersonaAppAccess(created.persona.id, {
        mcpServerName: 'github-jim',
      });
      expect(grant).toMatchObject({
        personaId: created.persona.id,
        mcpServerName: 'github-jim',
      });
      await expect(grantPersonaAppAccess(created.persona.id, {
        mcpServerName: 'github-jim',
      })).resolves.toEqual(grant);

      const launch = await authorizePersonaAppLaunch(
        created.persona.id,
        grant.id,
        { uri: 'ui://github/dashboard' },
      );
      expect(launch).toEqual({
        personaId: created.persona.id,
        grantId: grant.id,
        mcpServerName: 'github-jim',
        uri: 'ui://github/dashboard',
      });

      const after = await listPersonaBundle(created.persona.id);
      expect(after?.appGrants).toEqual([grant]);
      expect(after?.behaviorBindings).toEqual(before?.behaviorBindings);
      expect(after?.behaviorRevisions).toEqual(before?.behaviorRevisions);
    });
  });

  it('fails closed for foreign grants, stale configs, disabled Apps, and invalid resources', async () => {
    await inFreshWorkspace(async () => {
      const jim = await createPersonaFromRole({ name: 'Jim', idempotencyKey: 'phase6-owner-jim' });
      const sarah = await createPersonaFromRole({ name: 'Sarah', idempotencyKey: 'phase6-owner-sarah' });
      const jimGrant = await grantPersonaAppAccess(jim.persona.id, { mcpServerName: 'github-jim' });
      const sarahGrant = await grantPersonaAppAccess(sarah.persona.id, { mcpServerName: 'github-sarah' });

      await expect(authorizePersonaAppLaunch(jim.persona.id, sarahGrant.id, {
        uri: 'ui://github/dashboard',
      })).rejects.toBeInstanceOf(PersonaDomainNotFoundError);
      await expect(revokePersonaAppAccess(jim.persona.id, sarahGrant.id))
        .rejects.toBeInstanceOf(PersonaDomainNotFoundError);
      expect(await listPersonaDirectAppGrants(sarah.persona.id)).toEqual([sarahGrant]);

      await expect(grantPersonaAppAccess(jim.persona.id, { mcpServerName: 'disabled-app' }))
        .rejects.toBeInstanceOf(PersonaDomainConflictError);
      await expect(grantPersonaAppAccess(jim.persona.id, { mcpServerName: 'tools-only' }))
        .rejects.toBeInstanceOf(PersonaDomainConflictError);
      await expect(grantPersonaAppAccess(jim.persona.id, { mcpServerName: 'github-jim-copy' }))
        .rejects.toBeInstanceOf(PersonaDomainNotFoundError);
      await expect(authorizePersonaAppLaunch(jim.persona.id, jimGrant.id, {
        uri: 'https://attacker.invalid/not-an-app',
      })).rejects.toThrow();

      loadServerConfigsMock.mockResolvedValue([appConfig('github-sarah')]);
      await expect(authorizePersonaAppLaunch(jim.persona.id, jimGrant.id, {
        uri: 'ui://github/dashboard',
      })).rejects.toBeInstanceOf(PersonaDomainNotFoundError);
    });
  });

  it('allows immediate direct-grant revocation while Behavior Activity authority is leased', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createPersonaFromRole({ name: 'Jim', idempotencyKey: 'phase6-revoke' });
      const grant = await grantPersonaAppAccess(persona.id, { mcpServerName: 'github-jim' });
      await routePersonaMailboxItem({
        personaId: persona.id,
        idempotencyKey: 'phase6-live-activity',
        kind: 'assignment',
        source: { kind: 'assignment', sourceId: 'phase6-live-activity' },
        summary: 'Hold the Behavior lease while direct access is revoked.',
      });
      expect(await claimNextPersonaActivity({ personaId: persona.id, ttlMs: 60_000 }))
        .not.toBeNull();

      await expect(revokePersonaAppAccess(persona.id, grant.id)).resolves.toBeUndefined();
      expect(await listPersonaDirectAppGrants(persona.id)).toEqual([]);
    });
  });

  it('serializes launch authorization with immediate revocation', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createPersonaFromRole({
        name: 'Jim',
        idempotencyKey: 'phase6-linearizable-revoke',
      });
      const grant = await grantPersonaAppAccess(persona.id, {
        mcpServerName: 'github-jim',
      });

      let releaseConfigLookup: (() => void) | undefined;
      loadServerConfigsMock.mockImplementationOnce(() => new Promise((resolve) => {
        releaseConfigLookup = () => resolve([appConfig('github-jim')]);
      }));

      const authorization = authorizePersonaAppLaunch(persona.id, grant.id, {
        uri: 'ui://github/dashboard',
      });
      while (!releaseConfigLookup) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      let revoked = false;
      const revocation = revokePersonaAppAccess(persona.id, grant.id).then(() => {
        revoked = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(revoked).toBe(false);

      releaseConfigLookup();
      await expect(authorization).resolves.toMatchObject({ grantId: grant.id });
      await expect(revocation).resolves.toBeUndefined();
      await expect(authorizePersonaAppLaunch(persona.id, grant.id, {
        uri: 'ui://github/dashboard',
      })).rejects.toBeInstanceOf(PersonaDomainNotFoundError);
    });
  });

  it('switches configurations atomically and rejects stale or invalid targets', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createPersonaFromRole({
        name: 'Jim',
        idempotencyKey: 'phase6-atomic-switch',
      });
      const original = await grantPersonaAppAccess(persona.id, {
        mcpServerName: 'github-jim',
      });

      await expect(replacePersonaAppAccess(persona.id, original.id, {
        mcpServerName: 'disabled-app',
        expectedUpdatedAt: original.updatedAt,
      })).rejects.toBeInstanceOf(PersonaDomainConflictError);
      expect(await listPersonaDirectAppGrants(persona.id)).toEqual([original]);

      const replacement = await replacePersonaAppAccess(persona.id, original.id, {
        mcpServerName: 'github-sarah',
        expectedUpdatedAt: original.updatedAt,
      });
      expect(replacement).toMatchObject({
        personaId: persona.id,
        mcpServerName: 'github-sarah',
        createdAt: original.createdAt,
      });
      expect(await getPersonaAppGrant(original.id)).toBeNull();
      expect(await listPersonaDirectAppGrants(persona.id)).toEqual([replacement]);

      await expect(replacePersonaAppAccess(persona.id, replacement.id, {
        mcpServerName: 'github-jim',
        expectedUpdatedAt: original.updatedAt,
      })).rejects.toMatchObject({ code: 'PERSONA_APP_STALE_WRITE' });
    });
  });

  it('keeps identical Persona and config names isolated by workspace', async () => {
    let firstGrantId = '';
    await runWithWorkspace('phase6-workspace-a', async () => {
      const { persona } = await createPersonaFromRole({ id: 'jim_shared', name: 'Jim' });
      firstGrantId = (await grantPersonaAppAccess(persona.id, {
        mcpServerName: 'github-jim',
      })).id;
    });
    await runWithWorkspace('phase6-workspace-b', async () => {
      const { persona } = await createPersonaFromRole({ id: 'jim_shared', name: 'Jim' });
      const grant = await grantPersonaAppAccess(persona.id, { mcpServerName: 'github-jim' });
      expect(grant.id).toBe(firstGrantId);
      await revokePersonaAppAccess(persona.id, grant.id);
      expect(await listPersonaDirectAppGrants(persona.id)).toEqual([]);
    });
    await runWithWorkspace('phase6-workspace-a', async () => {
      expect((await listPersonaDirectAppGrants('jim_shared')).map((grant) => grant.id))
        .toEqual([firstGrantId]);
    });
  });

  it('includes direct grants in deletion review and erases them without deleting shared configs', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createPersonaFromRole({ name: 'Jim', idempotencyKey: 'phase6-delete' });
      const grant = await grantPersonaAppAccess(persona.id, { mcpServerName: 'github-jim' });
      const preview = await previewPersonaDeletion(persona.id);
      expect(preview.counts.appGrants).toBe(1);
      expect(preview.externalSharedResources).toEqual({
        mcpConfigNames: ['github-jim'],
        action: 'retained',
      });

      await deletePersona(persona.id, {
        previewToken: preview.previewToken,
        archivePolicy: 'anonymize',
        confirmation: 'DELETE',
      });
      expect(await getPersonaAppGrant(grant.id)).toBeNull();
      // Deletion never mutates the shared MCP config inventory.
      expect(loadServerConfigsMock).toHaveBeenCalled();
    });
  });
});
