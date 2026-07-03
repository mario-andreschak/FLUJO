"use client";

import React, { FC } from 'react';
import { EdgeProps } from '@xyflow/react';
import FlowEdgeBase from './FlowEdgeBase';

/** Flow-control edge — animated in its travel direction (both ways when
 * bidirectional); rendering lives in FlowEdgeBase. */
const CustomEdge: FC<EdgeProps> = (props) => <FlowEdgeBase {...props} variant="standard" />;

export default CustomEdge;
