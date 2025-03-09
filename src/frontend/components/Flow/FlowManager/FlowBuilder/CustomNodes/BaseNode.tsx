import React, { memo } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { styled } from '@mui/material/styles';
import { Paper, Typography } from '@mui/material';

const NodeContainer = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(1),
  minWidth: '150px',
  borderRadius: '8px',
  backgroundColor: theme.palette.background.paper,
  border: `1px solid ${theme.palette.divider}`,
}));

const BaseNode = ({ data }: NodeProps) => {
  return (
    <NodeContainer elevation={2}>
      <Handle type="target" position={Position.Top} />
      <Typography variant="subtitle2" textAlign="center">
        {data.label}
      </Typography>
      <Handle type="source" position={Position.Bottom} />
    </NodeContainer>
  );
};

export default memo(BaseNode);
