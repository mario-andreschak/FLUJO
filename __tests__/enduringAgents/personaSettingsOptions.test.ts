import { getPersonaSettingsOptions } from '@/backend/services/enduringAgents/personaSettingsOptions';
import { runWithWorkspace } from '@/utils/workspace';
import { ensureTestRole, TEST_ROLE_VERSION_ID } from './fixtures/personaFactory';

let workspaceSequence = 0;

describe('Persona settings choices', () => {
  it('exposes current Roles as readable choices pinned to exact versions', async () => {
    workspaceSequence += 1;
    await runWithWorkspace(
      `persona-settings-options-${process.pid}-${workspaceSequence}`,
      async () => {
        await ensureTestRole();
        const options = await getPersonaSettingsOptions();

        expect(options.roles).toEqual(expect.arrayContaining([
          expect.objectContaining({
            roleVersionId: TEST_ROLE_VERSION_ID,
            name: 'Test general Role',
          }),
        ]));
        expect(options.roles[0]?.description).toEqual(expect.any(String));
      },
    );
  });
});
