import { RoleEditor } from '@/frontend/components/Roles';

export default async function EditRolePage({ params }: { params: Promise<{ roleId: string }> }) {
  const { roleId } = await params;
  return <RoleEditor mode="edit" roleId={roleId} />;
}
