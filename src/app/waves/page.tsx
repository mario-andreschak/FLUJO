'use client';

import WavesManager from '@/frontend/components/Waves';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/waves/page');

export const WAVES_VIEWPORT_HEIGHT = {
  xs: 'calc(100dvh - 56px)',
  sm: 'calc(100dvh - 64px)',
} as const;

export default function WavesPage() {
  log.debug('Rendering WavesPage');
  return <WavesManager height={WAVES_VIEWPORT_HEIGHT} />;
}
