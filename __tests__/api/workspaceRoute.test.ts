import {
  WORKSPACE_HEADER,
  WorkspaceRequestError,
  parseWorkspaceParam,
} from '@/app/api/_workspace';
import { DEFAULT_WORKSPACE } from '@/utils/workspace';

describe('workspace API selection (#406)', () => {
  it('uses the default workspace when no selector is supplied', () => {
    expect(parseWorkspaceParam(new Request('http://localhost/api/flows'))).toBe(
      DEFAULT_WORKSPACE,
    );
  });

  it('uses a query selector before the workspace header', () => {
    expect(
      parseWorkspaceParam(
        new Request('http://localhost/api/flows?workspace=query-workspace', {
          headers: { [WORKSPACE_HEADER]: 'header-workspace' },
        }),
      ),
    ).toBe('query-workspace');
  });

  it('uses a valid workspace header when the query selector is absent', () => {
    expect(
      parseWorkspaceParam(
        new Request('http://localhost/api/flows', {
          headers: { [WORKSPACE_HEADER]: 'header-workspace' },
        }),
      ),
    ).toBe('header-workspace');
  });

  it('rejects traversal selectors with a consistent 400 error', () => {
    let error: unknown;
    try {
      parseWorkspaceParam(
        new Request('http://localhost/api/flows?workspace=..%2Fother'),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(WorkspaceRequestError);
    expect(error).toMatchObject({ status: 400 });
  });
});
