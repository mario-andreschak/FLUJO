import { createContext } from 'react';

/** Human-readable flow names available to nodes rendered in the FlowBuilder. */
export const FlowNamesContext = createContext<ReadonlyMap<string, string>>(new Map());
