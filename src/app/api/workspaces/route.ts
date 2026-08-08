import { NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { DEFAULT_WORKSPACE, listWorkspaces } from '@/utils/workspace';

const log = createLogger('app/api/workspaces');

/**
 * Read-only workspace discovery (#406).
 *
 * The navbar tabs are backed by what actually exists on disk, which keeps the UI
 * honest: there is no separate workspace registry that can drift from the
 * filesystem, and there is nothing to keep in sync when a directory is added or
 * removed out of band. Creation/rename/deletion are deliberately NOT exposed —
 * issue #406 asks only for the namespace, the migration and the tabs.
 *
 * `default-workspace` is always reported, even on a brand-new install where the
 * directory has not been created yet, so the client always has a valid initial
 * selection and never has to render an empty tab strip.
 *
 * Colors are derived from the name (see `workspaceColor`) rather than stored, so
 * a workspace keeps the same tab color on every machine and across restarts.
 */
export async function GET() {
  try {
    const workspaces = await listWorkspaces();
    return NextResponse.json({
      workspaces,
      defaultWorkspace: DEFAULT_WORKSPACE,
    });
  } catch (error) {
    log.error('Failed to list workspaces', error);
    // Degrade to the always-present default rather than breaking navigation.
    return NextResponse.json({
      workspaces: [
        { name: DEFAULT_WORKSPACE, color: '#6656E8', isDefault: true },
      ],
      defaultWorkspace: DEFAULT_WORKSPACE,
    });
  }
}
