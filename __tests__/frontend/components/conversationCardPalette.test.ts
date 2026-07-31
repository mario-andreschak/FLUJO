import { createTheme } from '@mui/material/styles';

import {
  conversationCardSplitBackground,
  conversationOriginColor,
  conversationStatusColor,
} from '@/frontend/components/Chat/conversationCardPalette';
import { flowNodeColors } from '@/frontend/utils/flowPaletteTokens';

describe('conversation card FlowBuilder palette', () => {
  const theme = createTheme({
    palette: {
      primary: { main: '#1111AA' },
      secondary: { main: '#2222BB' },
      warning: { main: '#EE9900' },
      success: { main: '#22AA66' },
      info: { main: '#00AACC' },
      error: { main: '#DD3355' },
    },
  });

  it('uses FlowBuilder action colors for the requested origins', () => {
    expect(conversationOriginColor('subflow', theme)).toBe(theme.palette.warning.main);
    expect(conversationOriginColor('schedule', theme)).toBe(flowNodeColors.light.signal);
    expect(conversationOriginColor('trigger', theme)).toBe(flowNodeColors.light.signal);
    expect(conversationOriginColor('chat', theme)).toBe(theme.palette.primary.main);
    expect(conversationOriginColor('unknown', theme)).toBe(theme.palette.primary.main);
  });

  it('expands the existing status-dot semantics into the status segment', () => {
    expect(conversationStatusColor('running', theme)).toBe(theme.palette.primary.main);
    expect(conversationStatusColor('awaiting_tool_approval', theme)).toBe(theme.palette.warning.main);
    expect(conversationStatusColor('paused_debug', theme)).toBe(theme.palette.secondary.main);
    expect(conversationStatusColor('completed', theme)).toBe(theme.palette.success.main);
    expect(conversationStatusColor('capped', theme)).toBe(theme.palette.info.main);
    expect(conversationStatusColor('error', theme)).toBe(theme.palette.error.main);
  });

  it('splits the card surface at exactly 90% origin and 10% status', () => {
    expect(conversationCardSplitBackground('#FF9900', '#22AA66', 0.3)).toBe(
      'linear-gradient(90deg, rgba(255, 153, 0, 0.3) 0%, rgba(255, 153, 0, 0.3) 90%, rgba(34, 170, 102, 0.3) 90%, rgba(34, 170, 102, 0.3) 100%)',
    );
  });
});
