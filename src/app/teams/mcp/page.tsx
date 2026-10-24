import { Suspense } from 'react';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import Spinner from '@/frontend/components/shared/Spinner';
import TeamMcps from '@/frontend/components/Teams/TeamMcps';

export const dynamic = 'force-dynamic';

export default async function TeamMcpsPage() {
  if ((await headers()).get('x-flujo-controller-account') !== '1') notFound();
  return <Suspense fallback={<Spinner />}><TeamMcps /></Suspense>;
}
