'use client';

import React from 'react';
import { useThemeUtils } from '@/frontend/utils/theme';
import FolderIcon from '@mui/icons-material/Folder';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import { MessageState } from '../../types';
import { useI18n } from '@/frontend/contexts/I18nContext';
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
  const { t } = useI18n();
  
  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
        <Typography variant="subtitle2">{t('mcp.local.arguments')}</Typography>
        <Stack direction="row" spacing={1}>
          <Button
            size="small"
            startIcon={<ContentPasteIcon />}
            onClick={onParseReadme}
            disabled={isParsingReadme}
            color="inherit"
            sx={{ color: 'text.secondary' }}
          >
            {t('mcp.local.parseReadme')}
          </Button>
          <Button
            size="small"
            startIcon={<ContentPasteIcon />}
            onClick={onParseClipboard}
            color="inherit"
            sx={{ color: 'text.secondary' }}
          >
            {t('mcp.local.parseClipboard')}
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
            <Tooltip title={t('mcp.local.selectFolder')}>
              <IconButton
                onClick={() => onFolderSelect(index)}
                size="small"
                sx={{ border: 1, borderColor: 'divider' }}
              >
                <FolderIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title={t('mcp.local.removeArgument')}>
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
          {t('mcp.local.addArgument')}
        </Button>
      </Stack>
    </Box>
  );
};

export default ArgumentsManager;
