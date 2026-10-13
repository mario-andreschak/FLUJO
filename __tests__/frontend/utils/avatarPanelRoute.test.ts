import { panelRoute } from '@/frontend/components/AvatarWorld/AvatarPanelBridge';
describe('trusted avatar panel routing', () => {
  it('keeps ordinary Flujo panel navigation in the current workspace', () => {
    expect(panelRoute('/flows?flowId=agent&mode=edit', 'http://localhost:4200', 'mine')).toBe('/flows?flowId=agent&mode=edit&workspace=mine&avatarEmbed=1');
    expect(panelRoute('/personas/persona-1', 'http://localhost:4200', 'mine')).toContain('workspace=mine');
  });
  it.each(['https://external.example/', '//external.example/models', '/models?workspace=another', '/api/env?includeSecrets=true', '/world', '/models\\outside', '/models\n'])('rejects cross-origin, cross-workspace, and non-panel destinations: %s', path => {
    expect(panelRoute(path, 'http://localhost:4200', 'mine')).toBeNull();
  });
});
