'use client';

import WavesManager from '@/frontend/components/Waves';
import { createLogger } from '@/utils/logger';
import { WAVES_VIEWPORT_HEIGHT } from './constants';

const log = createLogger('app/waves/page');

export default function WavesPage() {
  log.debug('Rendering WavesPage');
  return <WavesManager height={WAVES_VIEWPORT_HEIGHT} />;
}
