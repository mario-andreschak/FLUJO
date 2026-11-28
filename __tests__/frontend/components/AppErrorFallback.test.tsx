import { render, screen } from '@testing-library/react';
import { AppErrorFallback } from '@/frontend/components/AppWrapper';

describe('the full-screen error page', () => {
  it('says the workspace reconnects by itself when it heals a failed file load', () => {
    render(<AppErrorFallback healing />);
    expect(screen.getByText('The workspace hit a snag')).toBeInTheDocument();
    expect(screen.getByText(/reconnects to the local runtime by itself; you can also reload now/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload workspace' })).toBeInTheDocument();
  });

  it('asks for a reload when nothing heals by itself', () => {
    render(<AppErrorFallback healing={false} />);
    expect(screen.getByText(/Reload FLUJO to reconnect/)).toBeInTheDocument();
    expect(screen.queryByText(/by itself/)).not.toBeInTheDocument();
  });
});
