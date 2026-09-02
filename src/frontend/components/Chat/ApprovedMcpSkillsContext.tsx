'use client';

import React, { useEffect, useMemo } from 'react';
import {
  Box,
  Checkbox,
  FormControlLabel,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import {
  MCP_SKILLS_MAX_SELECTED_PER_TURN,
  mcpSkillCacheKey,
  type McpLoadedSkill,
} from '@/shared/types/mcp';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface ApprovedMcpSkillsContextProps {
  conversationId: string;
  skills: McpLoadedSkill[];
  selectedKeys: ReadonlySet<string>;
  onSelectionChange: (keys: ReadonlySet<string>) => void;
}

function skillKey(skill: McpLoadedSkill): string {
  return mcpSkillCacheKey(
    skill.identity.serverName,
    skill.identity.skillUri,
    skill.manifest.digest,
  );
}

/**
 * Picker for already approved and verified session Skills. It performs no
 * discovery or reads and never grants tools, roots, filesystem, or network.
 */
const ApprovedMcpSkillsContext: React.FC<ApprovedMcpSkillsContextProps> = ({
  conversationId,
  skills,
  selectedKeys,
  onSelectionChange,
}) => {
  const { t } = useI18n();
  const validKeys = useMemo(
    () => new Set(skills.map(skillKey)),
    [skills],
  );

  useEffect(() => {
    const next = new Set([...selectedKeys].filter((key) => validKeys.has(key)));
    if (
      next.size !== selectedKeys.size ||
      [...next].some((key) => !selectedKeys.has(key))
    ) {
      onSelectionChange(next);
    }
  }, [onSelectionChange, selectedKeys, validKeys]);

  if (!skills.length) return null;

  return (
    <Paper
      variant="outlined"
      data-testid="approved-mcp-skills"
      data-conversation-id={conversationId}
      sx={{ mb: 1, px: 1.25, py: 0.75 }}
    >
      <Stack spacing={0.25}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <AutoAwesomeIcon color="warning" fontSize="small" />
          <Typography variant="caption" fontWeight={700}>
            {t('mcp.skills.chatTitle')}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t('mcp.skills.chatWarning')}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
          {skills.map((skill) => {
            const key = skillKey(skill);
            return (
              <FormControlLabel
                key={key}
                sx={{ m: 0, mr: 1 }}
                control={(
                  <Checkbox
                    size="small"
                    checked={selectedKeys.has(key)}
                    disabled={
                      !selectedKeys.has(key) &&
                      selectedKeys.size >= MCP_SKILLS_MAX_SELECTED_PER_TURN
                    }
                    onChange={(event) => {
                      const next = new Set(selectedKeys);
                      if (event.target.checked) next.add(key);
                      else next.delete(key);
                      onSelectionChange(next);
                    }}
                  />
                )}
                label={(
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="caption" display="block">
                      {skill.entry.frontmatter.name} · {skill.identity.serverName}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      display="block"
                      sx={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                      {skill.identity.skillUri} · {skill.manifest.digest}
                    </Typography>
                  </Box>
                )}
              />
            );
          })}
        </Box>
      </Stack>
    </Paper>
  );
};

export default ApprovedMcpSkillsContext;
