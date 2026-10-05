import { fireEvent, render, screen } from '@testing-library/react';
import McpAgentJourney from '@/frontend/components/mcp/MCPServerManager/McpAgentJourney';
import { translate, type TranslationKey } from '@/frontend/i18n';
import { SUPPORTED_LOCALES, type SupportedLocale } from '@/frontend/i18n/locales';

let mockLocale: SupportedLocale = 'en';
jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({
    t: (key: TranslationKey, values?: Record<string, string | number>) => {
      const { translate } = jest.requireActual<typeof import('@/frontend/i18n')>('@/frontend/i18n');
      return translate(mockLocale, key, values);
    },
  }),
}));
jest.mock('next/link', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(
      function MockLink(props, ref) { return <a ref={ref} {...props} />; },
    ),
  };
});

const openGuide = () => fireEvent.click(screen.getByRole('button', { name: translate(mockLocale, 'mcp.journey.title') }));

describe('first MCP-to-agent navigation', () => {
  beforeEach(() => { mockLocale = 'en'; });

  it('offers real model/agent/help routes and invokes no connection or inspection on opening', () => {
    const onConnect = jest.fn();
    const onInspect = jest.fn();
    render(<McpAgentJourney servers={[]} onConnect={onConnect} onInspect={onInspect} />);
    openGuide();
    expect(screen.getByRole('link', { name: 'AI Setup' })).toHaveAttribute('href', '/models');
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute('href', '/flows?authoringMode=guided');
    expect(screen.getByRole('link', { name: 'Help' })).toHaveAttribute('href', '/docs');
    expect(screen.getByRole('button', { name: 'Inspect and test tools' })).toBeDisabled();
    expect(onConnect).not.toHaveBeenCalled();
    expect(onInspect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Connect App' }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('prefers a connected enabled app, respects explicit choice and never inspects a disabled one', () => {
    const onInspect = jest.fn();
    const servers = [
      { name: 'saved', status: 'disconnected' },
      { name: 'disabled', status: 'connected', disabled: true },
      { name: 'connected', status: 'connected' },
    ];
    const view = render(<McpAgentJourney servers={servers} onConnect={jest.fn()} onInspect={onInspect} />);
    openGuide();
    expect(screen.getByRole('status')).toHaveTextContent('A successful tool test is still needed');
    fireEvent.click(screen.getByRole('button', { name: 'Inspect and test tools' }));
    expect(onInspect).toHaveBeenLastCalledWith('connected');

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Saved app to inspect' }));
    expect(screen.queryByRole('option', { name: 'disabled' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'saved' }));
    expect(screen.getByRole('status')).toHaveTextContent('connection is not currently verified');
    fireEvent.click(screen.getByRole('button', { name: 'Inspect and test tools' }));
    expect(onInspect).toHaveBeenLastCalledWith('saved');

    view.rerender(<McpAgentJourney servers={[servers[1]]} onConnect={jest.fn()} onInspect={onInspect} />);
    expect(screen.getByRole('button', { name: 'Inspect and test tools' })).toBeDisabled();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it.each(SUPPORTED_LOCALES.map((locale) => locale.code))('labels actions and announces unverified state in %s', (locale) => {
    mockLocale = locale;
    render(<McpAgentJourney servers={[{ name: 'fixture', status: 'error' }]} onConnect={jest.fn()} onInspect={jest.fn()} />);
    openGuide();
    expect(screen.getByRole('button', { name: translate(locale, 'mcp.journey.inspect') })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: translate(locale, 'mcp.journey.savedApp') })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(translate(locale, 'mcp.journey.unverified'));
  });
});
