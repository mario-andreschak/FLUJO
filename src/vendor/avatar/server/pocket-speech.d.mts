export const POCKET_VOICES: Readonly<Record<string, string>>;
export const POCKET_MAX_TEXT: number;
export function pocketOrigin(origin?: string): string;
export function validatePocketSpeech(value: unknown): { text: string; locale: string };
export function pocketAvailability(origin?: string, fetchImpl?: typeof fetch, signal?: AbortSignal): Promise<boolean>;
export function synthesizePocket(value: unknown, origin?: string, fetchImpl?: typeof fetch, signal?: AbortSignal): Promise<Buffer>;
