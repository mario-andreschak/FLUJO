// Export client-safe utilities
export * from './common';
export * from './isElectron';

// Export server-only utilities
// These will only be available in server components
export * from '../../backend/utils/resolveGlobalVars';
