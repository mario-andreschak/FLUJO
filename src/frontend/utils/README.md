# Frontend Utilities

This directory contains utility functions and hooks for the frontend.

## Theme Utilities

The theme utilities provide a consistent way to handle theme-aware styling across the application.

### Available Utilities

- `useThemeUtils()`: A hook that provides theme-aware utility functions
  - `getThemeValue(lightValue, darkValue)`: Returns the appropriate value based on the current theme
  - `isDarkMode`: Boolean indicating if dark mode is currently active

- `getCssVar(variableName)`: Returns a CSS variable reference (e.g., `var(--background)`)

- `applyThemeStyles(element, isDarkMode)`: Applies theme-specific styles to an HTML element

### Usage Examples

```tsx
// Using useThemeUtils
import { useThemeUtils } from '@/frontend/utils';

function MyComponent() {
  const { getThemeValue, isDarkMode } = useThemeUtils();
  
  // Get a theme-specific value
  const backgroundColor = getThemeValue('#FFFFFF', '#2C3E50');
  
  return (
    <div style={{ backgroundColor }}>
      {isDarkMode ? 'Dark Mode' : 'Light Mode'}
    </div>
  );
}

// Using getCssVar
import { getCssVar } from '@/frontend/utils';

function AnotherComponent() {
  return (
    <div style={{ 
      color: getCssVar('foreground'),
      backgroundColor: getCssVar('background')
    }}>
      Using CSS Variables
    </div>
  );
}
```

## Theme Context

For direct access to the theme state and toggle function, you can use the `useTheme` hook from the ThemeContext:

```tsx
import { useTheme } from '@/frontend/contexts/ThemeContext';

function ThemeToggleButton() {
  const { isDarkMode, toggleTheme } = useTheme();
  
  return (
    <button onClick={toggleTheme}>
      {isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
    </button>
  );
}
```

## CSS Variables

The application defines the following CSS variables for theme-aware styling:

### Light Theme (default)
```css
--background: #FFFFFF;
--foreground: #2C3E50;
--paper-background: #F5F6FA;
--text-secondary: #7F8C8D;
```

### Dark Theme
```css
--background: #2C3E50;
--foreground: #ECF0F1;
--paper-background: #34495E;
--text-secondary: #BDC3C7;
```

These variables are automatically applied based on the current theme.
