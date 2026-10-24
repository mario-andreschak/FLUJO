import { Suspense } from 'react';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import Spinner from '@/frontend/components/shared/Spinner';
import TeamModels from '@/frontend/components/Teams/TeamModels';

export const dynamic = 'force-dynamic';

export default async function TeamModelsPage() {
  // UI availability only. The controller separately authorizes every request.
  if ((await headers()).get('x-flujo-controller-account') !== '1') notFound();
  return <Suspense fallback={<Spinner />}><TeamModels /></Suspense>;
}
