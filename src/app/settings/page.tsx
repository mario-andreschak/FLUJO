"use client";

import Settings from '@/frontend/components/Settings';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/settings/page');

export default function SettingsPage() {
  log.debug('Rendering SettingsPage');
  return (
    <main className="min-h-screen">
      <Settings />
    </main>
  );
}
