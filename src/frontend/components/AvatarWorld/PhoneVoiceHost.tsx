'use client';
import { usePhoneHostVoice } from '../PhoneHostBoundary';
import AvatarWorld from './index';

/** Adds host admission to the existing application; work/controllers remain owned by AvatarWorld. */
export default function PhoneVoiceHost() {
  const transport = usePhoneHostVoice();
  return transport ? <AvatarWorld voiceTransport={transport} /> : null;
}
