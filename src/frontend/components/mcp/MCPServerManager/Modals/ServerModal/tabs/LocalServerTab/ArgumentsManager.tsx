'use client';

import React from 'react';
import { useThemeUtils } from '@/frontend/utils/theme';
import FolderIcon from '@mui/icons-material/Folder';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import { MessageState } from '../../types';
import {
  Box,
  Button,
  IconButton,
  Stack,
  TextField,
  Typography,
  Tooltip
} from '@mui/material';

interface ArgumentsManagerProps {
  args: string[];
  onArgChange: (index: number, value: string) => void;
  onAddArg: () => void;
  onRemoveArg: (index: number) => void;
  onFolderSelect: (index: number) => void;
  onParseReadme: () => Promise<void>;
  onParseClipboard: () => Promise<void>;
  isParsingReadme: boolean;
}

const ArgumentsManager: React.FC<ArgumentsManagerProps> = ({
  args,
  onArgChange,
  onAddArg,
  onRemoveArg,
  onFolderSelect,
  onParseReadme,
  onParseClipboard,
  isParsingReadme
}) => {
  const { getThemeColor } = useThemeUtils();
  
  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
        <Typography variant="subtitle2">Arguments</Typography>
        <Stack direction="row" spacing={1}>
          <Button
            size="small"
            startIcon={<ContentPasteIcon />}
            onClick={onParseReadme}
            disabled={isParsingReadme}
            color="inherit"
            sx={{ color: 'text.secondary' }}
          >
            Parse README
          </Button>
          <Button
            size="small"
            startIcon={<ContentPasteIcon />}
            onClick={onParseClipboard}
            color="inherit"
            sx={{ color: 'text.secondary' }}
          >
            Parse from Clipboard
          </Button>
        </Stack>
      </Box>
      
      <Stack spacing={1}>
        {args.map((arg, index) => (
          <Stack key={index} direction="row" spacing={1}>
            <TextField
              fullWidth
              size="small"
              value={arg}
              onChange={e => onArgChange(index, e.target.value)}
              variant="outlined"
            />
            <Tooltip title="Select folder">
              <IconButton
                onClick={() => onFolderSelect(index)}
                size="small"
                sx={{ border: 1, borderColor: 'divider' }}
              >
                <FolderIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Remove argument">
              <IconButton
                onClick={() => onRemoveArg(index)}
                size="small"
                sx={{ border: 1, borderColor: 'divider' }}
              >
                <DeleteIcon />
              </IconButton>
            </Tooltip>
          </Stack>
        ))}
        
        <Button
          startIcon={<AddIcon />}
          onClick={onAddArg}
          color="primary"
          sx={{ alignSelf: 'flex-start', mt: 1 }}
        >
          Add Argument
        </Button>
      </Stack>
    </Box>
  );
};

export default ArgumentsManager;
