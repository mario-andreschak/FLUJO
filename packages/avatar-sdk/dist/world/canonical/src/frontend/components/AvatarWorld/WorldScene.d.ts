import type { AvatarWorldSnapshot } from '../../../shared/types/avatar.js';
import type { EyePhase } from './Eyes';
/** Ambient terrain is decorative. Only stored entities supply the small lights;
 * only the actual work/voice phase changes the scene's activity. */
export default function WorldScene(props: {
    snapshot: AvatarWorldSnapshot | null;
    phase: EyePhase;
    level: number;
    exploring: boolean;
}): import("react").JSX.Element;
