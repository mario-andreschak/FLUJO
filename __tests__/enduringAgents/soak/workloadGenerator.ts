import { PERSONA_INGRESS_MATRIX } from '../personaIngressMatrix';

export interface SoakWorkloadOptions {
  days: number;
  activitiesPerDay?: number;
  seed: number;
  startAt?: number;
}

export interface SoakActivity {
  id: string;
  day: number;
  scheduledAt: number;
  ingress: (typeof PERSONA_INGRESS_MATRIX)[number];
  variant: 'fact' | 'paraphrase' | 'contradiction' | 'noise';
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function generatePersonaSoakWorkload(options: SoakWorkloadOptions): SoakActivity[] {
  const perDay = options.activitiesPerDay ?? 20;
  if (!Number.isInteger(options.days) || options.days < 1) throw new TypeError('days must be positive.');
  if (!Number.isInteger(perDay) || perDay < 1) throw new TypeError('activitiesPerDay must be positive.');
  const random = mulberry32(options.seed);
  const startAt = options.startAt ?? Date.UTC(2026, 0, 1);
  const variants: SoakActivity['variant'][] = ['fact', 'paraphrase', 'contradiction', 'noise'];
  const activities: SoakActivity[] = [];
  for (let day = 1; day <= options.days; day += 1) {
    for (let offset = 0; offset < perDay; offset += 1) {
      const sequence = activities.length;
      // The first seven slots of every simulated week guarantee ingress coverage.
      const weeklyOffset = ((day - 1) * perDay + offset) % (7 * perDay);
      const ingressIndex = weeklyOffset < PERSONA_INGRESS_MATRIX.length
        ? weeklyOffset
        : Math.floor(random() * PERSONA_INGRESS_MATRIX.length);
      activities.push({
        id: `soak-${options.seed}-${sequence}`,
        day,
        scheduledAt: startAt + (day - 1) * 86_400_000 + Math.floor(random() * 86_400_000),
        ingress: PERSONA_INGRESS_MATRIX[ingressIndex],
        variant: variants[Math.floor(random() * variants.length)],
      });
    }
  }
  return activities.sort((a, b) => a.scheduledAt - b.scheduledAt || a.id.localeCompare(b.id));
}
