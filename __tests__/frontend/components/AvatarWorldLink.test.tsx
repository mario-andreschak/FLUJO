import { fireEvent, render, screen } from '@testing-library/react';
import WorldLink, { worldLinkDestination } from '@/frontend/components/AvatarWorld/WorldLink';

describe('avatar guide navigation', () => {
  it('opens a normal panel link through the existing world callback', () => {
    const navigate = jest.fn();
    render(<WorldLink href="/automation/triggers" workspace="mine" onNavigate={navigate}>Open routines</WorldLink>);
    const link = screen.getByRole('link', { name: 'Open routines' });
    expect(link).toHaveAttribute('href', '/automation/triggers?workspace=mine');
    expect(fireEvent.click(link)).toBe(false);
    expect(navigate).toHaveBeenCalledWith('/automation/triggers?workspace=mine');
  });
  it('normalizes same-origin absolute links while preserving the entity and fragment', () => {
    expect(worldLinkDestination('http://localhost/personas/resident?avatarEmbed=1#memory', 'http://localhost', 'mine'))
      .toEqual({ kind: 'panel', href: '/personas/resident?workspace=mine#memory' });
  });
  it('stops voice before a modified click without redirecting the world', () => {
    const navigate = jest.fn(), stopVoice = jest.fn();
    // The harness prevents jsdom's unsupported native navigation after the
    // link handler has made its decision; a browser keeps the normal href.
    render(<div onClick={event => event.preventDefault()}><WorldLink href="/models" workspace="mine" onNavigate={navigate} onOpen={stopVoice}>AI setup</WorldLink></div>);
    fireEvent.click(screen.getByRole('link', { name: 'AI setup' }), { ctrlKey: true });
    expect(stopVoice).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'AI setup' })).toHaveAttribute('href', '/models?workspace=mine');
  });
  it('stops voice for middle-click panel opens', () => {
    const navigate = jest.fn(), stopVoice = jest.fn();
    render(<WorldLink href="/models" workspace="mine" onNavigate={navigate} onOpen={stopVoice}>AI setup</WorldLink>);
    fireEvent(screen.getByRole('link', { name: 'AI setup' }), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(stopVoice).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });
  it.each(['/api/env?includeSecrets=true', '/models?workspace=other', '/world', 'javascript:alert(1)', 'http://user:password@external.example/', '/models\\outside'])('keeps an unsupported link inert: %s', href => {
    render(<WorldLink href={href} workspace="mine" onNavigate={jest.fn()}>Unavailable destination</WorldLink>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Unavailable destination')).toBeVisible();
  });
  it('opens external references separately without a world navigation callback', () => {
    render(<WorldLink href="https://example.com/docs" workspace="mine" onNavigate={jest.fn()}>Reference</WorldLink>);
    expect(screen.getByRole('link', { name: 'Reference' })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: 'Reference' })).toHaveAttribute('rel', 'noopener noreferrer');
  });
  it('preserves ordinary in-page fragment links', () => {
    expect(worldLinkDestination('#evidence', 'http://localhost', 'mine')).toEqual({ kind: 'fragment', href: '#evidence' });
  });
});
