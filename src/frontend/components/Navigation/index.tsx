"use client"
import { AppBar, Box, IconButton, Toolbar, Typography, useTheme as useMuiTheme } from '@mui/material';
import { useTheme } from '@/frontend/contexts/ThemeContext';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Navigation');
import Brightness4Icon from '@mui/icons-material/Brightness4';
import Brightness7Icon from '@mui/icons-material/Brightness7';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navItems = [
  { name: 'Models', path: '/models' },
  { name: 'MCP', path: '/mcp' },
  { name: 'Flows', path: '/flows' },
  { name: 'Chat', path: '/chat' },
  { name: 'Settings', path: '/settings' },
];

export default function Navigation() {
  const { toggleTheme, isDarkMode } = useTheme();
  const muiTheme = useMuiTheme();
  const pathname = usePathname();
  
  log.debug(`Rendering Navigation component with pathname: ${pathname}`);

  return (
    <AppBar position="sticky" color="default" elevation={1}>
      <Toolbar>
        <Typography
          variant="h6"
          component={Link}
          href="/"
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
