export type AvatarStyle = 'moss' | 'orbit' | 'spark';
export type EyePhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'usingApp' | 'waiting' | 'error';
export interface EyesProps {
    phase: EyePhase;
    avatar: AvatarStyle;
    small?: boolean;
    level?: number;
}
export default function Eyes({ phase, avatar, small, level }: EyesProps): import("react").JSX.Element;
