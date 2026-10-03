'use client';
import { RIVER_SCENES } from '@/frontend/components/AmbientWorld/sceneMap';
import type { AvatarWorldSnapshot, AvatarWorldObject } from '@/shared/types/avatar';
import type { WorldLocale } from './copy';
import { worldCopy } from './copy';
import styles from './world.module.css';

export type WorldPlace = 'models' | 'apps' | 'flows' | 'personas' | 'automations' | 'meetings' | 'packages' | 'archive' | 'settings';
export const PLACE_ROUTES: Record<WorldPlace, string> = { models: '/models', apps: '/mcp', flows: '/flows', personas: '/personas', automations: '/automation/triggers', meetings: '/meetings', packages: '/packages', archive: '/chat', settings: '/settings' };
const positions: Record<WorldPlace, [number, number]> = {
  models: [RIVER_SCENES.models.x, RIVER_SCENES.models.y], apps: [RIVER_SCENES.mcp.x, RIVER_SCENES.mcp.y],
  flows: [RIVER_SCENES.flows.x, RIVER_SCENES.flows.y], automations: [RIVER_SCENES.automations.x, RIVER_SCENES.automations.y],
  packages: [RIVER_SCENES.packages.x, RIVER_SCENES.packages.y], archive: [RIVER_SCENES.docs.x, RIVER_SCENES.docs.y],
  settings: [RIVER_SCENES.settings.x, 85], personas: [18, 65], meetings: [82, 73],
};
export const PLACE_KINDS: Partial<Record<WorldPlace, AvatarWorldObject['kind']>> = { apps: 'app', flows: 'flow', personas: 'persona', automations: 'automation', meetings: 'meeting', archive: 'artifact', packages: 'package' };

export default function Watershed({ snapshot, locale, selected, onSelect }: { snapshot: AvatarWorldSnapshot | null; locale: WorldLocale; selected: WorldPlace | null; onSelect: (place: WorldPlace) => void }) {
  const c = worldCopy(locale);
  const labels: Record<WorldPlace, string> = { models: c.springs, apps: c.harbor, flows: c.workshop, personas: c.residents, automations: c.routines, meetings: c.gathering, packages: c.market, archive: c.archive, settings: c.control };
  return <div className={styles.watershed} data-ready={Boolean(snapshot?.workModel?.ready)} aria-label={c.world}>
    <svg className={styles.landscape} viewBox="0 0 1000 700" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="avatar-river" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#fff" stopOpacity=".1" /><stop offset=".5" stopColor="#fff" stopOpacity=".55" /><stop offset="1" stopColor="#fff" stopOpacity=".06" /></linearGradient></defs>
      <path className={styles.terrain} d="M-100 360Q80 180 240 320T550 290T900 320L1100 580V800H-100Z" />
      <path className={styles.terrainFar} d="M-50 320Q140 200 300 285T620 220T1090 340" />
      <path className={styles.riverBank} d="M140 161C230 260 75 370 290 329S450 165 540 306S760 420 855 364S810 600 510 620" />
      <path className={styles.river} d="M140 161C230 260 75 370 290 329S450 165 540 306S760 420 855 364S810 600 510 620" />
      {Array.from({ length: Math.min(42, 8 + (snapshot?.objects.length ?? 0)) }, (_, i) => <g key={i} className={styles.reed} style={{ animationDelay: `${i % 7 * -.4}s` }} transform={`translate(${(i * 137 + 72) % 980} ${(i * 53 + 396) % 200 + 360})`}><path d="M0 20Q-8 5 0-18M0 20Q9 0 15-10M0 20Q-13 8-18 2" /></g>)}
      {[140, 320, 640, 820].map((x, i) => <circle key={x} className={styles.firefly} cx={x} cy={150 + i % 2 * 260} r="1.5" style={{ animationDelay: `${i * -2}s` }} />)}
    </svg>
    {(Object.keys(positions) as WorldPlace[]).map(place => {
      const count = snapshot?.objects.filter(o => o.kind === PLACE_KINDS[place]).length ?? 0;
      const active = place === 'models' ? snapshot?.workModel?.ready : count > 0;
      return <button key={place} type="button" className={styles.landmark} data-active={Boolean(active)} data-selected={selected === place}
        style={{ left: `${positions[place][0]}%`, top: `${positions[place][1]}%` }} onClick={() => onSelect(place)} aria-pressed={selected === place}>
        <svg viewBox="0 0 56 56" aria-hidden="true"><Landmark kind={place} active={Boolean(active)} /></svg>
        <span>{labels[place]}{count > 0 && <small>{count}</small>}</span>
      </button>;
    })}
  </div>;
}

function Landmark({ kind, active }: { kind: WorldPlace; active: boolean }) {
  if (kind === 'models') return <><path d="M8 39Q15 32 21 38T45 36M12 47Q21 39 31 44T50 42" /><path d="M22 31Q6 24 17 10Q20 3 27 8Q44 10 37 25Q34 30 22 31Z" />{active && <circle cx="27" cy="21" r="3" fill="currentColor" />}</>;
  if (kind === 'apps') return <><path d="M7 43H49M12 42V21H21V42M34 42V12H43V42M21 28H34" /><path d="M6 48Q13 43 20 48T43 48T53 48" /></>;
  if (kind === 'flows') return <><path d="M10 43V24L28 10L46 24V43ZM9 24H47M18 43V32H28V43M36 33V38" /><circle cx="29" cy="24" r="4" /></>;
  if (kind === 'personas') return <><path d="M8 43V28L19 19L30 28V43ZM30 43V18L39 11L48 18V43" /><path d="M15 43V34H23V43M35 27H43M35 33H43" /></>;
  if (kind === 'automations') return <><circle cx="28" cy="26" r="13" /><circle cx="28" cy="26" r="5" /><path d="M28 6V13M28 39V47M8 26H15M41 26H49M14 12L19 17M37 35L43 41M14 41L19 35M37 17L43 12M11 48H46" /></>;
  if (kind === 'meetings') return <><ellipse cx="28" cy="32" rx="18" ry="8" /><circle cx="10" cy="18" r="4" /><circle cx="28" cy="12" r="4" /><circle cx="46" cy="18" r="4" /><path d="M10 24V30M28 18V24M46 24V30M17 39V47M39 39V47" /></>;
  return <><path d="M10 43V22L28 12L46 22V43ZM8 43H49M16 26H40M18 43V32H38V43" /></>;
}
