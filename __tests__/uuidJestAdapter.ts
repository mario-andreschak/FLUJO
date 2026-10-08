import { randomUUID } from 'node:crypto';

// uuid@14 is ESM-only. The application and production build consume it
// natively; Jest's CommonJS runtime only needs the v4 surface FLUJO imports.
export const v4 = (): string => randomUUID();
