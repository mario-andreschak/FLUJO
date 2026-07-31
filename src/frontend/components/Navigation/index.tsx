"use client"
import { AppBar, Box, Drawer, IconButton, List, ListItemButton, ListItemText, ListSubheader, Toolbar, Typography, useTheme as useMuiTheme, useMediaQuery } from '@mui/material';
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
import { Fragment, useState } from 'react';

interface NavLink {
  type: 'link';
  name: string;
  path: string;
  tour: string;
  aliases?: string[];
  /** When true, the item is only shown if experimental features are enabled (#184). */
  experimental?: boolean;
}

interface NavGroup {
  type: 'group';
  name: string;
  children: NavLink[];
}

type NavItem = NavLink | NavGroup;

const navItems: NavItem[] = [
  { type: 'link', name: 'Models', path: '/models', tour: 'nav-models' },
  { type: 'link', name: 'MCP', path: '/mcp', tour: 'nav-mcp' },
  { type: 'link', name: 'Flows', path: '/flows', tour: 'nav-flows' },
  {
    type: 'group',
    name: 'Automation',
    children: [
      {
        type: 'link',
        name: 'Triggers',
        path: '/automation/triggers',
        aliases: ['/executions'],
        tour: 'nav-executions',
      },
      {
        type: 'link',
        name: 'Waves',
        path: '/automation/waves',
        aliases: ['/waves'],
        tour: 'nav-waves',
        experimental: true,
      },
    ],
  },
  { type: 'link', name: 'Packages', path: '/packages', tour: 'nav-packages', experimental: true },
  { type: 'link', name: 'Chat', path: '/chat', tour: 'nav-chat' },
  { type: 'link', name: 'Docs', path: '/docs', tour: 'nav-docs' },
  { type: 'link', name: 'Settings', path: '/settings', tour: 'nav-settings' },
];

const isActive = (item: NavLink, pathname: string) =>
  pathname === item.path || item.aliases?.includes(pathname) === true;

interface NavigationEntriesProps {
  items: NavItem[];
  pathname: string;
  mobile?: boolean;
  onNavigate: (href: string) => (event: React.MouseEvent) => void;
}

/** Shared hierarchy renderer for the desktop toolbar and mobile drawer. */
function NavigationEntries({ items, pathname, mobile = false, onNavigate }: NavigationEntriesProps) {
  const renderLink = (item: NavLink, nested = false) => {
    const active = isActive(item, pathname);

    if (mobile) {
      return (
        <ListItemButton
          key={item.path}
          component={Link}
          href={item.path}
          data-tour={item.tour}
          onClick={onNavigate(item.path)}
          selected={active}
          sx={{ pl: nested ? 4 : 2 }}
        >
          <ListItemText
            primary={item.name}
            primaryTypographyProps={{ fontWeight: active ? 600 : 400 }}
          />
        </ListItemButton>
      );
    }

    return (
      <Typography
        key={item.path}
        component={Link}
        href={item.path}
        data-tour={item.tour}
        onClick={onNavigate(item.path)}
        sx={{
          color: active ? 'primary.main' : 'text.primary',
          textDecoration: 'none',
          fontWeight: active ? 600 : 400,
          fontSize: nested ? '0.875rem' : undefined,
          '&:hover': { color: 'primary.main' },
        }}
      >
        {item.name}
      </Typography>
    );
  };

  return (
    <>
      {items.map((item) => {
        if (item.type === 'link') return renderLink(item);

        if (mobile) {
          return (
            <Fragment key={item.name}>
              <ListSubheader component="div" disableSticky sx={{ lineHeight: 2.5, fontWeight: 600 }}>
                {item.name}
              </ListSubheader>
              {item.children.map((child) => renderLink(child, true))}
            </Fragment>
          );
        }

        return (
          <Box key={item.name} sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <Typography variant="caption" sx={{ lineHeight: 1.1, fontWeight: 600, color: 'text.secondary' }}>
              {item.name}
            </Typography>
            <Box sx={{ display: 'flex', gap: 1.5 }}>
              {item.children.map((child) => renderLink(child, true))}
            </Box>
          </Box>
        );
      })}
    </>
  );
}

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
  const visibleNavItems = navItems.reduce<NavItem[]>((visible, item) => {
    if (item.type === 'link') {
      if (!item.experimental || experimentalEnabled) visible.push(item);
      return visible;
    }

    const children = item.children.filter((child) => !child.experimental || experimentalEnabled);
    if (children.length > 0) visible.push({ ...item, children });
    return visible;
  }, []);

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
          <NavigationEntries items={visibleNavItems} pathname={pathname} onNavigate={handleNavClick} />
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
            <NavigationEntries
              items={visibleNavItems}
              pathname={pathname}
              mobile
              onNavigate={handleDrawerNavClick}
            />
          </List>
        </Box>
      </Drawer>
    </AppBar>
  );
}
