import type { AvatarWorldSnapshot, AvatarWorldObject } from '../../../shared/types/avatar.js';
import type { WorldLocale } from './copy';
export type WorldPlace = 'models' | 'apps' | 'flows' | 'personas' | 'automations' | 'meetings' | 'packages' | 'archive' | 'settings';
export declare const PLACE_ROUTES: Record<WorldPlace, string>;
export declare const LANDMARK_POSITIONS: Record<WorldPlace, [number, number]>;
export declare const PLACE_KINDS: Partial<Record<WorldPlace, AvatarWorldObject['kind']>>;
export default function Watershed({ snapshot, locale, selected, onSelect }: {
    snapshot: AvatarWorldSnapshot | null;
    locale: WorldLocale;
    selected: WorldPlace | null;
    onSelect: (place: WorldPlace) => void;
}): import("react").JSX.Element;
