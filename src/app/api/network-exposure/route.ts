import { NextResponse } from 'next/server';
import { getExposureMode } from '@/utils/http/exposureMode';
import { getInstallMode } from '@/utils/paths';
import { assertUnlocked } from '@/utils/encryption/lockGate';

/** Runtime state for Settings. The persisted choice takes effect on restart. */
export async function GET() {
  const locked = await assertUnlocked();
  if (locked) return locked;
  return NextResponse.json(
    {
      active: getExposureMode(),
      installMode: getInstallMode(),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
