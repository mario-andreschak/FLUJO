import {
  BUILT_IN_DEVELOPER_ROLE_VERSION_ID,
} from '@/backend/services/enduringAgents';
import { getPersonaSettingsOptions } from '@/backend/services/enduringAgents/personaSettingsOptions';
import { runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

describe('Persona settings choices', () => {
  it('exposes current Roles as readable choices pinned to exact versions', async () => {
    workspaceSequence += 1;
    await runWithWorkspace(
      `persona-settings-options-${process.pid}-${workspaceSequence}`,
      async () => {
        const options = await getPersonaSettingsOptions();

        expect(options.roles).toEqual(expect.arrayContaining([
          expect.objectContaining({
            roleVersionId: BUILT_IN_DEVELOPER_ROLE_VERSION_ID,
            name: 'Developer',
          }),
        ]));
        expect(options.roles[0]?.description).toEqual(expect.any(String));
      },
    );
  });
});
