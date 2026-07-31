"use client";

import {
  AppBar,
  Box,
  Chip,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Stack,
  Tab,
  Tabs,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme as useMuiTheme,
} from '@mui/material';
import {
  BoltRounded,
  Brightness4Rounded,
  Brightness7Rounded,
  ChatBubbleRounded,
  CloseRounded,
  HubRounded,
  InsightsRounded,
  Inventory2Rounded,
  MemoryRounded,
  MenuBookRounded,
  MenuRounded,
  SettingsRounded,
} from '@mui/icons-material';
import { alpha } from '@mui/material/styles';
import { ElementType, Fragment, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import BugReportButton from '@/frontend/components/BugReport/BugReportButton';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { useTheme } from '@/frontend/contexts/ThemeContext';
import { interceptNavigation } from '@/frontend/utils/navigationGuard';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Navigation');

interface NavLink {
  type: 'link';
  name: string;
  path: string;
  tour: string;
  icon: ElementType;
  aliases?: string[];
  experimental?: boolean;
}

interface NavGroup {
  type: 'group';
  name: string;
  icon: ElementType;
  children: NavLink[];
}

type NavItem = NavLink | NavGroup;

const navItems: NavItem[] = [
  { type: 'link', name: 'AI Setup', path: '/models', tour: 'nav-models', icon: MemoryRounded },
  { type: 'link', name: 'Connected Apps', path: '/mcp', tour: 'nav-mcp', icon: HubRounded },
  { type: 'link', name: 'Talk', path: '/chat', tour: 'nav-chat', icon: ChatBubbleRounded },
  {
    type: 'group',
    name: 'More',
    icon: MenuRounded,
    children: [
      {
        type: 'link',
        name: 'Automations',
        path: '/automation/triggers',
        aliases: ['/executions', '/automation/waves', '/waves'],
        tour: 'nav-executions',
        icon: BoltRounded,
      },
      {
        type: 'link',
        name: 'Extensions',
        path: '/packages',
        tour: 'nav-packages',
        icon: Inventory2Rounded,
      },
      {
        type: 'link',
        name: 'Activity',
        path: '/statistics',
        tour: 'nav-statistics',
        icon: InsightsRounded,
      },
      { type: 'link', name: 'Help', path: '/docs', tour: 'nav-docs', icon: MenuBookRounded },
      { type: 'link', name: 'Settings', path: '/settings', tour: 'nav-settings', icon: SettingsRounded },
    ],
  },
];

const isActive = (item: NavLink, pathname: string) =>
  pathname === item.path || pathname.startsWith(`${item.path}/`) || item.aliases?.includes(pathname) === true;

interface NavigationEntriesProps {
  items: NavItem[];
  pathname: string;
  mobile?: boolean;
  onNavigate: (href: string) => (event: React.MouseEvent) => void;
}

function NavigationEntries({ items, pathname, mobile = false, onNavigate }: NavigationEntriesProps) {
  const theme = useMuiTheme();

  const renderLink = (item: NavLink, nested = false) => {
    const active = isActive(item, pathname);
    const Icon = item.icon;

    if (mobile) {
      return (
        <ListItemButton
          key={item.path}
          component={Link}
          href={item.path}
          aria-current={active ? 'page' : undefined}
          data-tour={item.tour}
          onClick={onNavigate(item.path)}
          selected={active}
          sx={{
            mx: 1,
            mb: 0.5,
            pl: nested ? 3 : 1.5,
            minHeight: 48,
            '&.Mui-selected': {
              boxShadow: `inset 0 0 0 1px ${alpha(theme.palette.primary.main, 0.22)}`,
            },
          }}
        >
          <ListItemIcon sx={{ minWidth: 38, color: active ? 'primary.light' : 'text.secondary' }}>
            <Icon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary={item.name}
            primaryTypographyProps={{ fontWeight: active ? 700 : 590, fontSize: '0.92rem' }}
          />
          {active && (
            <Box
              aria-hidden="true"
              sx={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                bgcolor: 'secondary.main',
                boxShadow: `0 0 12px ${theme.palette.secondary.main}`,
              }}
            />
          )}
        </ListItemButton>
      );
    }

    return (
      <Box
        key={item.path}
        component={Link}
        href={item.path}
        aria-current={active ? 'page' : undefined}
        data-tour={item.tour}
        onClick={onNavigate(item.path)}
        sx={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.7,
          minHeight: 42,
          px: 1.35,
          border: '1px solid',
          borderColor: active ? alpha(theme.palette.primary.main, 0.26) : 'transparent',
          borderRadius: 2.5,
          color: active ? 'text.primary' : 'text.secondary',
          bgcolor: active ? alpha(theme.palette.primary.main, 0.11) : 'transparent',
          textDecoration: 'none',
          fontSize: '0.88rem',
          fontWeight: active ? 720 : 620,
          whiteSpace: 'nowrap',
          transition: 'all 170ms ease',
          '&::after': active ? {
            position: 'absolute',
            right: 10,
            bottom: -1,
            left: 10,
            height: 2,
            borderRadius: 2,
            content: '""',
            background: `linear-gradient(90deg, ${theme.palette.primary.main}, ${theme.palette.secondary.main})`,
            boxShadow: `0 0 14px ${alpha(theme.palette.primary.main, 0.7)}`,
          } : undefined,
          '&:hover': {
            color: 'text.primary',
            bgcolor: alpha(theme.palette.primary.main, active ? 0.14 : 0.07),
            transform: 'translateY(-1px)',
          },
        }}
      >
        <Icon sx={{ fontSize: 17, color: active ? 'primary.light' : 'text.secondary' }} />
        {item.name}
      </Box>
    );
  };

  return (
    <>
      {items.map((item) => {
        if (item.type === 'link') return renderLink(item);

        if (mobile) {
          return (
            <Fragment key={item.name}>
              <ListSubheader
                component="div"
                disableSticky
                sx={{
                  mt: 1.5,
                  mb: 0.5,
                  px: 2.5,
                  color: 'text.secondary',
                  bgcolor: 'transparent',
                  fontSize: '0.68rem',
                  fontWeight: 760,
                  letterSpacing: '0.13em',
                  lineHeight: 2.8,
                  textTransform: 'uppercase',
                }}
              >
                {item.name}
              </ListSubheader>
              {item.children.map((child) => renderLink(child, true))}
            </Fragment>
          );
        }

        const active = item.children.some((child) => isActive(child, pathname));
        const landingPage = item.children[0];
        const Icon = item.icon;

        return (
          <Box
            key={item.name}
            component={Link}
            href={landingPage.path}
            aria-current={isActive(landingPage, pathname) ? 'page' : undefined}
            data-tour={landingPage.tour}
            onClick={onNavigate(landingPage.path)}
            sx={{
              position: 'relative',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.7,
              minHeight: 42,
              px: 1.35,
              border: '1px solid',
              borderColor: active ? alpha(theme.palette.primary.main, 0.26) : 'transparent',
              borderRadius: 2.5,
              color: active ? 'text.primary' : 'text.secondary',
              bgcolor: active ? alpha(theme.palette.primary.main, 0.11) : 'transparent',
              textDecoration: 'none',
              fontSize: '0.88rem',
              fontWeight: active ? 720 : 620,
              whiteSpace: 'nowrap',
              transition: 'all 170ms ease',
              '&::after': active ? {
                position: 'absolute',
                right: 10,
                bottom: -1,
                left: 10,
                height: 2,
                borderRadius: 2,
                content: '""',
                background: `linear-gradient(90deg, ${theme.palette.primary.main}, ${theme.palette.secondary.main})`,
              } : undefined,
              '&:hover': {
                color: 'text.primary',
                bgcolor: alpha(theme.palette.primary.main, active ? 0.14 : 0.07),
                transform: 'translateY(-1px)',
              },
            }}
          >
            <Icon sx={{ fontSize: 17, color: active ? 'primary.light' : 'text.secondary' }} />
            {item.name}
          </Box>
        );
      })}
    </>
  );
}

export default function Navigation() {
  const { toggleTheme, isDarkMode } = useTheme();
  const theme = useMuiTheme();
  const pathname = usePathname();
  const router = useRouter();
  const { settings, settingsHydrated } = useStorage();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isCompact = useMediaQuery('(max-width:1279px)');

  log.debug(`Rendering Navigation component with pathname: ${pathname}`);

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

  const activeNavGroup = visibleNavItems.find(
    (item): item is NavGroup =>
      item.type === 'group' && item.children.some((child) => isActive(child, pathname))
  );
  const activeSubtab =
    activeNavGroup?.children.find((child) => isActive(child, pathname))?.path ?? false;
  const hasActiveNavGroup = Boolean(activeNavGroup);

  useEffect(() => {
    document.documentElement.classList.toggle('has-app-subnav', hasActiveNavGroup);
    return () => document.documentElement.classList.remove('has-app-subnav');
  }, [hasActiveNavGroup]);

  const handleNavClick = (href: string) => (event: React.MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    ) {
      return;
    }
    if (interceptNavigation(() => router.push(href))) {
      event.preventDefault();
    }
  };

  const handleDrawerNavClick = (href: string) => (event: React.MouseEvent) => {
    setDrawerOpen(false);
    handleNavClick(href)(event);
  };

  return (
    <AppBar position="sticky" color="default" elevation={0} data-app-navigation>
      <Toolbar
        sx={{
          gap: { xs: 1, sm: 1.5 },
          px: { xs: 1.5, sm: 2.5, xl: 3.5 },
          minHeight: 'var(--app-bar-height) !important',
        }}
      >
        {isCompact && (
          <IconButton
            color="inherit"
            aria-label="Open navigation menu"
            onClick={() => setDrawerOpen(true)}
            sx={{ border: 1, borderColor: 'divider' }}
          >
            <MenuRounded />
          </IconButton>
        )}

        <Box
          component={Link}
          href="/"
          onClick={handleNavClick('/')}
          aria-label="FLUJO home"
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.1,
            mr: { xs: 0, xl: 0.75 },
            color: 'text.primary',
            textDecoration: 'none',
          }}
        >
          <Box
            aria-hidden="true"
            sx={{
              position: 'relative',
              display: 'grid',
              width: 38,
              height: 38,
              placeItems: 'center',
              overflow: 'hidden',
              border: `1px solid ${alpha(theme.palette.common.white, 0.18)}`,
              borderRadius: '13px',
              color: '#fff',
              background: `linear-gradient(145deg, ${theme.palette.primary.light}, ${theme.palette.primary.main} 48%, ${theme.palette.secondary.main})`,
              boxShadow: `0 10px 28px ${alpha(theme.palette.primary.main, 0.32)}`,
              fontWeight: 850,
              letterSpacing: '-0.06em',
              '&::after': {
                position: 'absolute',
                inset: 0,
                content: '""',
                background: 'linear-gradient(145deg, rgba(255,255,255,.32), transparent 38%)',
              },
            }}
          >
            <Box component="span" sx={{ zIndex: 1 }}>F</Box>
          </Box>
          <Box sx={{ display: { xs: 'none', sm: 'block' }, lineHeight: 1 }}>
            <Typography sx={{ fontSize: '0.98rem', fontWeight: 810, letterSpacing: '-0.045em' }}>
              FLUJO
            </Typography>
            <Typography sx={{ mt: 0.4, color: 'text.secondary', fontSize: '0.59rem', fontWeight: 700, letterSpacing: '0.13em', textTransform: 'uppercase' }}>
              Private AI, made simple
            </Typography>
          </Box>
        </Box>

        {!isCompact && (
          <Box
            component="nav"
            aria-label="Primary navigation"
            sx={{
              display: 'flex',
              flex: 1,
              alignItems: 'center',
              gap: 0.3,
              minWidth: 0,
            }}
          >
            <NavigationEntries
              items={visibleNavItems}
              pathname={pathname}
              onNavigate={handleNavClick}
            />
          </Box>
        )}

        {isCompact && <Box sx={{ flex: 1 }} />}

        <Stack direction="row" spacing={0.7} alignItems="center">
          {!isCompact && (
            <Chip
              size="small"
              label="Private on this device"
              icon={
                <Box
                  component="span"
                  sx={{
                    width: 7,
                    height: 7,
                    ml: 0.4,
                    borderRadius: '50%',
                    bgcolor: 'primary.main',
                    boxShadow: `0 0 10px ${theme.palette.primary.main}`,
                  }}
                />
              }
              sx={{
                height: 34,
                border: 1,
                borderColor: 'divider',
                color: 'text.secondary',
                bgcolor: alpha(theme.palette.background.paper, 0.5),
                '& .MuiChip-label': { px: 1, fontSize: '0.72rem' },
              }}
            />
          )}

          <BugReportButton variant="icon" />

          <Tooltip title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}>
            <IconButton
              onClick={() => {
                log.debug(`Theme toggle clicked, current mode: ${isDarkMode ? 'dark' : 'light'}`);
                toggleTheme();
              }}
              color="inherit"
              aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              sx={{ border: 1, borderColor: 'divider' }}
            >
              {isDarkMode ? <Brightness7Rounded fontSize="small" /> : <Brightness4Rounded fontSize="small" />}
            </IconButton>
          </Tooltip>
        </Stack>
      </Toolbar>

      {activeNavGroup && (
        <Box
          sx={{
            display: { xs: 'none', md: 'flex' },
            justifyContent: 'center',
            minHeight: 'var(--subnav-height)',
            borderTop: 1,
            borderColor: 'divider',
            backgroundColor: alpha(theme.palette.background.paper, 0.34),
          }}
        >
          <Tabs
            value={activeSubtab}
            aria-label={`${activeNavGroup.name} sections`}
            sx={{ minHeight: 'var(--subnav-height)' }}
          >
            {activeNavGroup.children.map((child) => {
              const Icon = child.icon;
              return (
                <Tab
                  key={child.path}
                  component={Link}
                  href={child.path}
                  aria-current={child.path === activeSubtab ? 'page' : undefined}
                  value={child.path}
                  icon={<Icon sx={{ fontSize: 16 }} />}
                  iconPosition="start"
                  label={child.name}
                  data-tour={child.tour}
                  onClick={handleNavClick(child.path)}
                  sx={{ minHeight: 'var(--subnav-height)', py: 0 }}
                />
              );
            })}
          </Tabs>
        </Box>
      )}

      <Drawer
        anchor="left"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        ModalProps={{ keepMounted: true }}
        PaperProps={{
          sx: {
            width: { xs: 'min(88vw, 340px)', sm: 340 },
            p: 1,
          },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1, py: 1.2 }}>
          <Box
            component={Link}
            href="/"
            onClick={handleDrawerNavClick('/')}
            sx={{ display: 'flex', alignItems: 'center', gap: 1.2, color: 'text.primary', textDecoration: 'none' }}
          >
            <Box
              sx={{
                display: 'grid',
                width: 38,
                height: 38,
                placeItems: 'center',
                borderRadius: '13px',
                color: '#fff',
                background: `linear-gradient(145deg, ${theme.palette.primary.light}, ${theme.palette.primary.main} 48%, ${theme.palette.secondary.main})`,
                fontWeight: 850,
              }}
            >
              F
            </Box>
            <Box>
              <Typography sx={{ fontWeight: 800, lineHeight: 1 }}>FLUJO</Typography>
              <Typography variant="caption" color="text.secondary">Private AI, made simple</Typography>
            </Box>
          </Box>
          <IconButton aria-label="Close navigation menu" onClick={() => setDrawerOpen(false)}>
            <CloseRounded />
          </IconButton>
        </Box>

        <Box sx={{ mx: 1, mb: 1.4, p: 1.2, border: 1, borderColor: 'divider', borderRadius: 3, bgcolor: alpha(theme.palette.success.main, 0.06) }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'success.main', boxShadow: `0 0 12px ${theme.palette.success.main}` }} />
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Private workspace on this device
            </Typography>
          </Stack>
        </Box>

        <List disablePadding>
          <NavigationEntries
            items={visibleNavItems}
            pathname={pathname}
            mobile
            onNavigate={handleDrawerNavClick}
          />
        </List>
      </Drawer>
    </AppBar>
  );
}
