import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PeopleSettings from '@/frontend/components/Settings/PeopleSettings';

type Route = (init?: RequestInit) => { status?: number; body: unknown };

function mockApi(routes: Record<string, Route>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const method = init?.method ?? 'GET';
    const route = routes[`${method} ${url}`] ?? routes[url];
    if (!route) return { ok: false, status: 404, json: async () => ({ error: 'none' }) };
    const { status = 200, body } = route(init);
    return { ok: status < 400, status, json: async () => body };
  }) as never;
  return calls;
}

const ACCESS = '/api/owner/access';
const PEOPLE = '/api/owner/people';
const RECORD = '/api/owner/audit?limit=50';
const owner = { id: 'owner-id', name: 'Owner', role: 'admin', expiresAt: 4_000_000_000_000, status: 'active', self: true };
const anna = { id: 'anna-id', name: 'Anna', role: 'operator', expiresAt: 4_000_000_000_000, status: 'active', self: false, workspaceId: 'site-a', flowIds: ['flow-1'] };

describe('PeopleSettings', () => {
  const originalFetch = global.fetch;
  afterAll(() => { global.fetch = originalFetch; });

  it('explains how to turn it on when it is off, and offers no button that could lock anyone out', async () => {
    mockApi({ [ACCESS]: () => ({ body: { mode: 'off' } }) });
    render(<PeopleSettings />);
    expect(await screen.findByText('Named access is off')).toBeInTheDocument();
    expect(screen.getByText(/owner-access\.mjs enable/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('turns it on from a policy with owner credentials', async () => {
    let mode = 'policy';
    const calls = mockApi({
      [`GET ${ACCESS}`]: () => ({ body: { mode, canManage: true, canReadRecord: true } }),
      [`POST ${ACCESS}`]: () => { mode = 'named'; return { body: { mode: 'named', changed: true } }; },
      [PEOPLE]: () => ({ body: { people: [owner] } }),
      [RECORD]: () => ({ body: { entries: [] } }),
    });
    render(<PeopleSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on named access' }));
    expect(await screen.findByText('Add a person')).toBeInTheDocument();
    expect(JSON.parse(calls.find(call => call.init?.method === 'POST')!.init!.body as string)).toEqual({ action: 'enable' });
  });

  it('shows a new secret once, and it is gone after dismissing', async () => {
    const secret = `flo_v1_${'s'.repeat(43)}`;
    const calls = mockApi({
      [`GET ${ACCESS}`]: () => ({ body: { mode: 'named', canManage: true, canReadRecord: false } }),
      [`GET ${PEOPLE}`]: () => ({ body: { people: [owner] } }),
      [`POST ${PEOPLE}`]: () => ({ status: 201, body: { person: anna, token: secret } }),
    });
    render(<PeopleSettings />);
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Anna' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create access' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByDisplayValue(secret)).toBeInTheDocument();
    expect(within(dialog).getByText(/only time it is shown/)).toBeInTheDocument();
    const sent = JSON.parse(calls.find(call => call.init?.method === 'POST')!.init!.body as string);
    expect(sent).toMatchObject({ name: 'Anna', role: 'operator' });
    expect(sent.expiresAt).toBeGreaterThan(Date.now());
    fireEvent.click(within(dialog).getByRole('button', { name: 'I saved it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(secret);
  });

  it('confirms before revoking, and shows the plain reason when it is refused', async () => {
    const calls = mockApi({
      [`GET ${ACCESS}`]: () => ({ body: { mode: 'named', canManage: true, canReadRecord: false } }),
      [`GET ${PEOPLE}`]: () => ({ body: { people: [owner, anna] } }),
      [`DELETE ${PEOPLE}/owner-id`]: () => ({ status: 409, body: { error: 'This is the last administrator.', code: 'LAST_ADMIN' } }),
    });
    render(<PeopleSettings />);
    const row = (await screen.findByText('Owner')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    expect(calls.some(call => call.init?.method === 'DELETE')).toBe(false);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This is the last administrator.');
  });

  it('shows limits and the record, and hides management from someone who only reads the record', async () => {
    mockApi({
      [`GET ${ACCESS}`]: () => ({ body: { mode: 'named', canManage: false, canReadRecord: true, recordWritable: false } }),
      [RECORD]: () => ({ body: { entries: [{ at: 1_700_000_000_000, action: 'approval.decide', outcome: 'ok', detail: 'approve', target: 'conversation-1', actor: { name: 'Anna', endUser: 'staff-17' } }] } }),
    });
    render(<PeopleSettings />);
    expect(await screen.findByText('approval.decide (approve)')).toBeInTheDocument();
    expect(screen.getByText('Anna / staff-17')).toBeInTheDocument();
    expect(screen.getByText(/could not be written recently/)).toBeInTheDocument();
    expect(screen.queryByText('Add a person')).not.toBeInTheDocument();
  });

  it('says so plainly when the page cannot load or the role does not include it', async () => {
    mockApi({ [ACCESS]: () => ({ status: 403, body: { error: 'Forbidden' } }) });
    render(<PeopleSettings />);
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
  });
});
