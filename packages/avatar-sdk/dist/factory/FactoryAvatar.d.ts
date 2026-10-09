import { type AvatarStyle } from '../client/Eyes.js';
export type AvatarLocale = 'es' | 'pt' | 'en';
export interface FactoryAvatarObservation {
    factoryId: string;
    revision: number;
    cursor: string;
    observedAt: string;
    readState: 'fresh' | 'stale' | 'unavailable' | 'preview';
    mission: string;
    selectedCell?: {
        id: string;
        purpose: string;
        heartbeat: string;
        reportedStatus: 'reserved' | 'ready' | 'retired';
        activityEvidence: 'idle' | 'recent' | 'uncertain';
    };
    selectedTask?: {
        id: string;
        attempt: number;
        owner: string | null;
        reportedStatus: 'ready' | 'running' | 'review' | 'verified' | 'delivered' | 'rejected';
        candidateDigest: string | null;
        reviewEvidenceDigest: string | null;
    };
    unresolvedEffects: number;
    effectsDrained: boolean;
    workerQuiescence: 'unverified';
    commands: false;
    voice: false;
}
export interface FactoryAvatarProps {
    observation: FactoryAvatarObservation | null;
    avatar: AvatarStyle;
    locale: AvatarLocale;
    onInspect(target: {
        kind: 'cell' | 'task' | 'effect';
        id: string;
    }): void;
}
/** Pure presentation of host-validated facts. Never reads or dispatches backend work. */
export declare function FactoryAvatar({ observation, avatar, locale, onInspect }: FactoryAvatarProps): import("react").JSX.Element;
