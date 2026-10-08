import PersonasDesk from '@/frontend/components/Personas';

export default async function PersonaDetailPage({
  params,
}: {
  params: Promise<{ personaId: string }>;
}) {
  const { personaId } = await params;
  return <PersonasDesk initialPersonaId={personaId} />;
}
