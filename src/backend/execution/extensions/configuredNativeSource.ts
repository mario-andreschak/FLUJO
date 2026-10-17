import { nativeSourceParent } from '@/backend/execution/extensions/configuredNativeParent';
import { createNativeSourceComposition } from './nativeSourceComposition';

// This module is selected only for a Parent-backed build. Ordinary Source
// retains configuredAdapter.ts; a missing producer fails during selected build.
if (!nativeSourceParent) throw new Error('A trusted Native Source Parent module is required.');
export const configuredNativeSource = createNativeSourceComposition(nativeSourceParent);
export const configuredExecutionAdapter = configuredNativeSource.adapter;
