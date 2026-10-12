'use client';
import type { AvatarWorldSnapshot, AvatarWorldObject } from '@/shared/types/avatar';
import type { WorldLocale } from './copy';
import { worldCopy } from './copy';
import styles from './world.module.css';

export type WorldPlace = 'models' | 'apps' | 'flows' | 'personas' | 'automations' | 'meetings' | 'packages' | 'archive' | 'settings';
export const PLACE_ROUTES: Record<WorldPlace, string> = { models: '/models', apps: '/mcp', flows: '/flows', personas: '/personas', automations: '/automation/triggers', meetings: '/meetings', packages: '/packages', archive: '/chat', settings: '/settings' };
export const LANDMARK_POSITIONS: Record<WorldPlace, [number, number]> = {
  models: [17, 49], apps: [77, 59], flows: [30, 62], automations: [83, 42],
  packages: [72, 76], archive: [43, 77], settings: [87, 78], personas: [65, 49], meetings: [15, 72],
};
export const PLACE_KINDS: Partial<Record<WorldPlace, AvatarWorldObject['kind']>> = { apps: 'app', flows: 'flow', personas: 'persona', automations: 'automation', meetings: 'meeting', archive: 'artifact', packages: 'package' };

export default function Watershed({ snapshot, locale, selected, onSelect }: { snapshot: AvatarWorldSnapshot | null; locale: WorldLocale; selected: WorldPlace | null; onSelect: (place: WorldPlace) => void }) {
  const c = worldCopy(locale);
  const labels: Record<WorldPlace, string> = { models: c.springs, apps: c.harbor, flows: c.workshop, personas: c.residents, automations: c.routines, meetings: c.gathering, packages: c.market, archive: c.archive, settings: c.control };
  return <div className={styles.watershed} data-ready={Boolean(snapshot?.workModel?.ready)} aria-label={c.world}>
    {(Object.keys(LANDMARK_POSITIONS) as WorldPlace[]).map(place => {
      const count = snapshot?.objects.filter(o => o.kind === PLACE_KINDS[place]).length ?? 0;
      const active = place === 'models' ? snapshot?.workModel?.ready : count > 0;
      return <button key={place} type="button" className={styles.landmark} data-active={Boolean(active)} data-selected={selected === place}
        style={{ left: `clamp(52px,${LANDMARK_POSITIONS[place][0]}%,calc(100% - 52px))`, top: `${LANDMARK_POSITIONS[place][1]}%` }} onClick={() => onSelect(place)} aria-pressed={selected === place}>
        <span className={styles.landmarkTarget} aria-hidden="true" />
        <span>{labels[place]}{count > 0 && <small>{count}</small>}</span>
      </button>;
    })}
  </div>;
}
