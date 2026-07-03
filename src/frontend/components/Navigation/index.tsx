"use client"
import { AppBar, Box, IconButton, Toolbar, Typography, useTheme as useMuiTheme } from '@mui/material';
import { useTheme } from '@/frontend/contexts/ThemeContext';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Navigation');
import Brightness4Icon from '@mui/icons-material/Brightness4';
import Brightness7Icon from '@mui/icons-material/Brightness7';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { interceptNavigation } from '@/frontend/utils/navigationGuard';

const navItems = [
  { name: 'Models', path: '/models', tour: 'nav-models' },
  { name: 'MCP', path: '/mcp', tour: 'nav-mcp' },
  { name: 'Flows', path: '/flows', tour: 'nav-flows' },
  { name: 'Chat', path: '/chat', tour: 'nav-chat' },
  { name: 'Docs', path: '/docs', tour: 'nav-docs' },
  { name: 'Settings', path: '/settings', tour: 'nav-settings' },
];

export default function Navigation() {
  const { toggleTheme, isDarkMode } = useTheme();
  const muiTheme = useMuiTheme();
  const pathname = usePathname();
  const router = useRouter();

  log.debug(`Rendering Navigation component with pathname: ${pathname}`);

  // Route nav clicks through the navigation guard so a page with unsaved
  // work (e.g. the flow editor) can show its Save/Discard dialog instead of
  // being unmounted instantly. Modified clicks (new tab, etc.) keep native
  // link behavior.
  const handleNavClick = (href: string) => (e: React.MouseEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
      return;
    }
    if (interceptNavigation(() => router.push(href))) {
      e.preventDefault();
    }
  };

  return (
    <AppBar position="sticky" color="default" elevation={1}>
      <Toolbar>
        <Typography
          variant="h6"
          component={Link}
          href="/"
          onClick={handleNavClick('/')}
          sx={{
            color: 'text.primary',
            textDecoration: 'none',
            flexGrow: 0,
            mr: 4,
            fontWeight: 600,
          }}
        >
          FLUJO
        </Typography>

        <Box sx={{ flexGrow: 1, display: 'flex', gap: 2 }}>
          {navItems.map((item) => (
            <Typography
              key={item.path}
              component={Link}
              href={item.path}
              data-tour={item.tour}
              onClick={handleNavClick(item.path)}
              sx={{
                color: pathname === item.path ? 'primary.main' : 'text.primary',
                textDecoration: 'none',
                fontWeight: pathname === item.path ? 600 : 400,
                '&:hover': {
                  color: 'primary.main',
                },
              }}
            >
              {item.name}
            </Typography>
          ))}
        </Box>

        <IconButton 
          onClick={() => {
            log.debug(`Theme toggle clicked, current mode: ${isDarkMode ? 'dark' : 'light'}`);
            toggleTheme();
          }} 
          color="inherit"
        >
          {isDarkMode ? <Brightness7Icon /> : <Brightness4Icon />}
        </IconButton>
      </Toolbar>
    </AppBar>
  );
}
