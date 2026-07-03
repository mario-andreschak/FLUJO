"use client";

import React, { FC } from 'react';
import { EdgeProps } from '@xyflow/react';
import FlowEdgeBase from './FlowEdgeBase';

/** MCP tool-wiring edge — info-colored, not animated (tool wiring has no
 * flow direction); rendering lives in FlowEdgeBase. */
const MCPEdge: FC<EdgeProps> = (props) => <FlowEdgeBase {...props} variant="mcp" />;

export default MCPEdge;
