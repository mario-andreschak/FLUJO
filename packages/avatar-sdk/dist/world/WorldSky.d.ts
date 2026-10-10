import { type ReactNode } from 'react';
import { type WorldSkyIntent, type WorldSkyLayer, type WorldSkyModel, type WorldSkySelection } from './selection.js';
export interface WorldSkyProps {
    world: ReactNode;
    sky: ReactNode;
    model: WorldSkyModel | null;
    selection: WorldSkySelection | null;
    onNavigate(intent: WorldSkyIntent): void;
    initialLayer?: WorldSkyLayer;
    locale?: 'en' | 'es' | 'pt';
}
/** A camera between existing host surfaces. Children keep their own runtime. */
export declare function WorldSky({ world, sky, model, selection, onNavigate, initialLayer, locale }: WorldSkyProps): import("react").JSX.Element;
