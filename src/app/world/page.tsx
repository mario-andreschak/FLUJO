import AvatarWorld from '@/frontend/components/AvatarWorld';
import PhoneVoiceHost from '@/frontend/components/AvatarWorld/PhoneVoiceHost';
import { connection } from 'next/server';

export default async function WorldPage() {
  await connection();
  return process.env.FLUJO_AVATAR_PHONE_HOST === '1' ? <PhoneVoiceHost /> : <AvatarWorld />;
}
