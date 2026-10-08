import { RoleDetail } from '@/frontend/components/Roles';

export default async function RoleDetailPage({ params }: { params: Promise<{ roleId: string }> }) {
  const { roleId } = await params;
  return <RoleDetail roleId={roleId} />;
}
