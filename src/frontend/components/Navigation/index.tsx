"use client"
import { AppBar, Box, Drawer, IconButton, List, ListItemButton, ListItemText, Toolbar, Typography, useTheme as useMuiTheme, useMediaQuery } from '@mui/material';
import { useTheme } from '@/frontend/contexts/ThemeContext';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Navigation');
import Brightness4Icon from '@mui/icons-material/Brightness4';
import Brightness7Icon from '@mui/icons-material/Brightness7';
import MenuIcon from '@mui/icons-material/Menu';
import BugReportButton from '@/frontend/components/BugReport/BugReportButton';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { interceptNavigation } from '@/frontend/utils/navigationGuard';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { useState } from 'react';

interface NavItem {
  name: string;
  path: string;
  tour: string;
  /** When true, the item is only shown if experimental features are enabled (#184). */
  experimental?: boolean;
}

const navItems: NavItem[] = [
  { name: 'Models', path: '/models', tour: 'nav-models' },
  { name: 'MCP', path: '/mcp', tour: 'nav-mcp' },
  { name: 'Flows', path: '/flows', tour: 'nav-flows' },
  { name: 'Executions', path: '/executions', tour: 'nav-executions' },
  { name: 'Waves', path: '/waves', tour: 'nav-waves', experimental: true },
  { name: 'Packages', path: '/packages', tour: 'nav-packages', experimental: true },
  { name: 'Chat', path: '/chat', tour: 'nav-chat' },
  { name: 'Docs', path: '/docs', tour: 'nav-docs' },
  { name: 'Settings', path: '/settings', tour: 'nav-settings' },
];

export default function Navigation() {
  const { toggleTheme, isDarkMode } = useTheme();
  const muiTheme = useMuiTheme();
  const pathname = usePathname();
  const router = useRouter();
  const { settings, settingsHydrated } = useStorage();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isMobile = useMediaQuery(muiTheme.breakpoints.down('md'));

  log.debug(`Rendering Navigation component with pathname: ${pathname}`);

  // Experimental features default OFF (#184). Until settings are actually
  // hydrated from storage we render the default (hidden) state to avoid a
  // flash of the experimental Waves entry.
  const experimentalEnabled = settingsHydrated && (settings?.experimental?.enabled ?? false);
  const visibleNavItems = navItems.filter(
    (item) => !item.experimental || experimentalEnabled
  );

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

  const handleDrawerNavClick = (href: string) => (e: React.MouseEvent) => {
    setDrawerOpen(false);
    handleNavClick(href)(e);
  };

  return (
    <AppBar position="sticky" color="default" elevation={1}>
      <Toolbar>
        {/* Hamburger menu button — visible only on mobile */}
        {isMobile && (
          <IconButton
            edge="start"
            color="inherit"
            aria-label="open navigation menu"
            onClick={() => setDrawerOpen(true)}
            sx={{ mr: 1 }}
          >
            <MenuIcon />
          </IconButton>
        )}

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

        {/* Desktop nav links — hidden on mobile */}
        <Box sx={{ flexGrow: 1, display: { xs: 'none', md: 'flex' }, gap: 2 }}>
          {visibleNavItems.map((item) => (
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

        {/* Spacer on mobile to push icons to the right */}
        {isMobile && <Box sx={{ flexGrow: 1 }} />}

        <BugReportButton variant="icon" />

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

      {/* Mobile navigation drawer */}
      <Drawer
        anchor="left"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        ModalProps={{ keepMounted: true }}
        PaperProps={{ sx: { width: 240 } }}
      >
        <Box sx={{ pt: 1 }}>
          <Typography
            variant="h6"
            component={Link}
            href="/"
            onClick={handleDrawerNavClick('/')}
            sx={{
              display: 'block',
              color: 'text.primary',
              textDecoration: 'none',
              fontWeight: 600,
              px: 2,
              py: 1.5,
            }}
          >
            FLUJO
          </Typography>
          <List disablePadding>
            {visibleNavItems.map((item) => (
              <ListItemButton
                key={item.path}
                component={Link}
                href={item.path}
                data-tour={item.tour}
                onClick={handleDrawerNavClick(item.path)}
                selected={pathname === item.path}
              >
                <ListItemText
                  primary={item.name}
                  primaryTypographyProps={{
                    fontWeight: pathname === item.path ? 600 : 400,
                  }}
                />
              </ListItemButton>
            ))}
          </List>
        </Box>
      </Drawer>
    </AppBar>
  );
}
