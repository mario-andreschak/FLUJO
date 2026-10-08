import React from 'react';
import { Box, Typography, FormControlLabel, Switch, Checkbox, TextField } from '@mui/material';
import HistoryIcon from '@mui/icons-material/History';
import ShortTextIcon from '@mui/icons-material/ShortText';
import EditNoteIcon from '@mui/icons-material/EditNote';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import OptionCard from '@/frontend/components/shared/OptionCard';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { Model, ProcessNodeData } from './types';

type InputMode = 'full-history' | 'latest-message' | 'isolated';
type OutputMode = 'full-conversation' | 'latest-message';

export interface PromptIOControlsProps {
  excludeModelPrompt: boolean;
  setExcludeModelPrompt: (value: boolean) => void;
  excludeStartNodePrompt: boolean;
  setExcludeStartNodePrompt: (value: boolean) => void;
  excludeSystemPrompt: boolean;
  setExcludeSystemPrompt: (value: boolean) => void;
  inputMode: InputMode;
  setInputMode: (value: InputMode) => void;
  isolatedPrompt: string;
  setIsolatedPrompt: (value: string) => void;
  allowCallerPrompt: boolean;
  setAllowCallerPrompt: (value: boolean) => void;
  outputMode: OutputMode;
  setOutputMode: (value: OutputMode) => void;
  isModelBound: boolean;
  models: Model[];
  nodeData: ProcessNodeData;
}

/**
 * Input/Output tab of the ProcessNode modal (issue #300).
 *
 * Extracted verbatim from the former left-of-editor controls in
 * PromptTemplateEditor so the toggles / OptionCards live in their own tab while
 * the PromptBuilder editor (in the Task tab) stays permanently mounted and its
 * `insertText` ref keeps working across tab switches. Pure presentational: all
 * state still lives in the root modal and is threaded in via props.
 */
const PromptIOControls: React.FC<PromptIOControlsProps> = ({
  excludeModelPrompt,
  setExcludeModelPrompt,
  excludeStartNodePrompt,
  setExcludeStartNodePrompt,
  excludeSystemPrompt,
  setExcludeSystemPrompt,
  inputMode,
  setInputMode,
  isolatedPrompt,
  setIsolatedPrompt,
  allowCallerPrompt,
  setAllowCallerPrompt,
  outputMode,
  setOutputMode,
  isModelBound,
  models,
  nodeData,
}) => {
  const { t } = useI18n();
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      {/* Exclude toggles */}
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={excludeModelPrompt}
              onChange={(e) => setExcludeModelPrompt(e.target.checked)}
              color="primary"
              size="small"
            />
          }
          label={t('flows.process.excludeModel')}
        />
        <FormControlLabel
          control={
            <Switch
              checked={excludeStartNodePrompt}
              onChange={(e) => setExcludeStartNodePrompt(e.target.checked)}
              color="primary"
              size="small"
            />
          }
          label={t('flows.process.excludeStart')}
        />
        <FormControlLabel
          control={
            <Switch
              checked={excludeSystemPrompt}
              onChange={(e) => setExcludeSystemPrompt(e.target.checked)}
              color="primary"
              size="small"
            />
          }
          label={t('flows.process.excludeSystem')}
        />
      </Box>

      {/* Prompt inclusion preview */}
      <Box sx={{ mb: 2, p: 2, bgcolor: 'rgba(0, 0, 0, 0.03)', borderRadius: 1, fontSize: '0.85rem' }}>
        <Typography variant="caption" sx={{ display: 'block', mb: 1, fontWeight: 'bold' }}>
          {t('flows.process.renderOrder')}
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {!excludeStartNodePrompt && (
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <Typography variant="caption" sx={{ color: 'primary.main', fontWeight: 'medium' }}>
                1. {t('flows.process.startPrompt')}
              </Typography>
              <Typography variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>
                {t('flows.process.fromStart')}
              </Typography>
            </Box>
          )}
          {!excludeModelPrompt && isModelBound && (
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <Typography variant="caption" sx={{ color: 'secondary.main', fontWeight: 'medium' }}>
                {!excludeStartNodePrompt ? '2.' : '1.'} {t('flows.process.modelPrompt')}
              </Typography>
              <Typography variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>
                {t('flows.process.fromModel', {
                  model: (() => {
                    const modelId = nodeData.properties?.boundModel;
                    if (!modelId) return t('flows.process.none');
                    const model = models.find(m => m.id === modelId);
                    return model ? (model.displayName || model.name) : nodeData.properties?.modelName || t('flows.process.none');
                  })(),
                })}
              </Typography>
            </Box>
          )}
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Typography variant="caption" sx={{ fontWeight: 'medium' }}>
              {(!excludeStartNodePrompt && !excludeModelPrompt && isModelBound) ? '3.' :
                (!excludeStartNodePrompt || (!excludeModelPrompt && isModelBound)) ? '2.' : '1.'} {t('flows.process.nodePrompt')}
            </Typography>
            <Typography variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>
              {t('flows.process.fromTask')}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Typography variant="caption" sx={{ fontWeight: 'medium' }}>
              {(!excludeStartNodePrompt && !excludeModelPrompt && isModelBound) ? '4.' :
                (!excludeStartNodePrompt || (!excludeModelPrompt && isModelBound)) ? '3.' : '2.'}{' '}
              {inputMode === 'isolated'
                ? t('flows.subflow.isolatedPrompt')
                : inputMode === 'latest-message'
                  ? t('flows.subflow.latest')
                  : t('flows.process.history')}
            </Typography>
            <Typography variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>
              {inputMode === 'isolated'
                ? t('flows.process.isolatedDetail')
                : inputMode === 'latest-message'
                  ? t('flows.process.latestDetail')
                  : t('flows.process.historyDetail')}
            </Typography>
          </Box>
        </Box>
      </Box>

      {/* Which conversation the model sees — mirrors the subflow node's input modes. */}
      <Box sx={{ mb: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          {t('flows.process.receiveTitle')}
        </Typography>
        <Box role="radiogroup" aria-label={t('flows.process.inputAria')} sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
          <OptionCard
            selected={inputMode === 'full-history'}
            onClick={() => setInputMode('full-history')}
            icon={<HistoryIcon fontSize="small" />}
            title={t('flows.subflow.fullHistory')}
            description={t('flows.process.fullInputHelp')}
          />
          <OptionCard
            selected={inputMode === 'latest-message'}
            onClick={() => setInputMode('latest-message')}
            icon={<ShortTextIcon fontSize="small" />}
            title={t('flows.subflow.latest')}
            description={t('flows.process.latestInputHelp')}
          />
          <OptionCard
            selected={inputMode === 'isolated'}
            onClick={() => setInputMode('isolated')}
            icon={<EditNoteIcon fontSize="small" />}
            title={t('flows.subflow.isolated')}
            description={t('flows.process.isolatedInputHelp')}
          />
        </Box>

        {inputMode === 'isolated' && (
          <>
            <FormControlLabel
              sx={{ mt: 1, display: 'block' }}
              control={
                <Checkbox
                  checked={allowCallerPrompt}
                  onChange={(e) => setAllowCallerPrompt(e.target.checked)}
                />
              }
              label={t('flows.subflow.allowCallerPrompt')}
            />
            <Typography variant="body2" color="text.secondary" sx={{ ml: 4, mt: -0.5 }}>
              {t('flows.process.callerPromptHelp')}
            </Typography>
            <TextField
              fullWidth
              label={allowCallerPrompt ? t('flows.subflow.defaultPrompt') : t('flows.subflow.isolatedPrompt')}
              value={isolatedPrompt}
              onChange={(e) => setIsolatedPrompt(e.target.value)}
              margin="normal"
              multiline
              rows={2}
              helperText={
                allowCallerPrompt
                  ? t('flows.process.defaultUserHelp')
                  : t('flows.process.isolatedUserHelp')
              }
            />
          </>
        )}
      </Box>

      {/* What LATER steps see of this node's work — the output-side counterpart. */}
      <Box sx={{ mb: 1 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          {t('flows.process.outputTitle')}
        </Typography>
        <Box role="radiogroup" aria-label={t('flows.process.outputAria')} sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
          <OptionCard
            selected={outputMode === 'full-conversation'}
            onClick={() => setOutputMode('full-conversation')}
            icon={<ForumOutlinedIcon fontSize="small" />}
            title={t('flows.subflow.fullHistory')}
            description={t('flows.process.fullOutputHelp')}
          />
          <OptionCard
            selected={outputMode === 'latest-message'}
            onClick={() => setOutputMode('latest-message')}
            icon={<ChatBubbleOutlineIcon fontSize="small" />}
            title={t('flows.subflow.latest')}
            description={t('flows.process.latestOutputHelp')}
          />
        </Box>
      </Box>
    </Box>
  );
};

export default PromptIOControls;
