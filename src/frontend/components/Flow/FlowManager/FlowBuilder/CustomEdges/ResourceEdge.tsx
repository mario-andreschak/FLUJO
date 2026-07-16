"use client";

import React, { FC } from 'react';
import { EdgeProps } from '@xyflow/react';
import FlowEdgeBase from './FlowEdgeBase';

/** Resource data-wiring edge (Tier 3) — teal, not animated, DIRECTIONAL
 * (resource→process = the step consumes; process→resource = the step
 * produces); rendering lives in FlowEdgeBase. */
const ResourceEdge: FC<EdgeProps> = (props) => <FlowEdgeBase {...props} variant="resource" />;

export default ResourceEdge;
