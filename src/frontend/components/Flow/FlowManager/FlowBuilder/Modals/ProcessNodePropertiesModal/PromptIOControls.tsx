import React from 'react';
import { Box, Typography, FormControlLabel, Switch, Checkbox, TextField } from '@mui/material';
import HistoryIcon from '@mui/icons-material/History';
import ShortTextIcon from '@mui/icons-material/ShortText';
import EditNoteIcon from '@mui/icons-material/EditNote';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import OptionCard from '@/frontend/components/shared/OptionCard';

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
  models: any[];
  nodeData: any;
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
          label="Exclude Model Prompt"
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
          label="Exclude Start Node Prompt"
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
          label="Exclude System Prompt"
        />
      </Box>

      {/* Prompt inclusion preview */}
      <Box sx={{ mb: 2, p: 2, bgcolor: 'rgba(0, 0, 0, 0.03)', borderRadius: 1, fontSize: '0.85rem' }}>
        <Typography variant="caption" sx={{ display: 'block', mb: 1, fontWeight: 'bold' }}>
          Prompt Rendering Order:
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {!excludeStartNodePrompt && (
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <Typography variant="caption" sx={{ color: 'primary.main', fontWeight: 'medium' }}>
                1. Start Node Prompt
              </Typography>
              <Typography variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>
                (from the Start node in this flow)
              </Typography>
            </Box>
          )}
          {!excludeModelPrompt && isModelBound && (
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <Typography variant="caption" sx={{ color: 'secondary.main', fontWeight: 'medium' }}>
                {!excludeStartNodePrompt ? '2.' : '1.'} Model Prompt
              </Typography>
              <Typography variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>
                (from the selected model: {
                  // Find the model by ID to get its display name
                  (() => {
                    const modelId = nodeData.properties?.boundModel;
                    if (!modelId) return 'None';
                    const model = models.find(m => m.id === modelId);
                    return model ? (model.displayName || model.name) : nodeData.properties?.modelName || 'None';
                  })()
                })
              </Typography>
            </Box>
          )}
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Typography variant="caption" sx={{ fontWeight: 'medium' }}>
              {(!excludeStartNodePrompt && !excludeModelPrompt && isModelBound) ? '3.' :
                (!excludeStartNodePrompt || (!excludeModelPrompt && isModelBound)) ? '2.' : '1.'} This Node&apos;s Prompt
            </Typography>
            <Typography variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>
              (defined in the Task tab)
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Typography variant="caption" sx={{ fontWeight: 'medium' }}>
              {(!excludeStartNodePrompt && !excludeModelPrompt && isModelBound) ? '4.' :
                (!excludeStartNodePrompt || (!excludeModelPrompt && isModelBound)) ? '3.' : '2.'}{' '}
              {inputMode === 'isolated'
                ? 'Isolated prompt'
                : inputMode === 'latest-message'
                  ? 'Latest message only'
                  : 'Conversation History'}
            </Typography>
            <Typography variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>
              {inputMode === 'isolated'
                ? '(the prompt below, as the user message)'
                : inputMode === 'latest-message'
                  ? '(the last user message + the last assistant response)'
                  : '(coming from ChatCompletion endpoint)'}
            </Typography>
          </Box>
        </Box>
      </Box>

      {/* Which conversation the model sees — mirrors the subflow node's input modes. */}
      <Box sx={{ mb: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          What does the model receive?
        </Typography>
        <Box role="radiogroup" aria-label="Model input" sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
          <OptionCard
            selected={inputMode === 'full-history'}
            onClick={() => setInputMode('full-history')}
            icon={<HistoryIcon fontSize="small" />}
            title="Full conversation"
            description="The model sees this node's prompt plus the whole conversation so far. The default."
          />
          <OptionCard
            selected={inputMode === 'latest-message'}
            onClick={() => setInputMode('latest-message')}
            icon={<ShortTextIcon fontSize="small" />}
            title="Latest message only"
            description="The model sees this node's prompt plus the most recent exchange — the last user message and the last assistant response — plus this turn's own in-flight tool calls and results."
          />
          <OptionCard
            selected={inputMode === 'isolated'}
            onClick={() => setInputMode('isolated')}
            icon={<EditNoteIcon fontSize="small" />}
            title="Isolated"
            description="The conversation is ignored. The model sees this node's prompt plus the prompt below, sent as the user message."
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
              label="Let the caller pass a prompt"
            />
            <Typography variant="body2" color="text.secondary" sx={{ ml: 4, mt: -0.5 }}>
              When on, a step that hands off to this node can attach an instruction through
              its handoff tool, overriding the prompt below. The prompt below is then used
              only as a default when the caller sends none.
            </Typography>
            <TextField
              fullWidth
              label={allowCallerPrompt ? 'Default prompt (used if the caller sends none)' : 'Isolated prompt'}
              value={isolatedPrompt}
              onChange={(e) => setIsolatedPrompt(e.target.value)}
              margin="normal"
              multiline
              rows={2}
              helperText={
                allowCallerPrompt
                  ? 'The default user message. A routing model may override it via the handoff tool. The prior conversation is not shown to the model (it is still kept in the transcript for later nodes).'
                  : 'Sent to the model as the user message. The prior conversation is not shown to the model (it is still kept in the transcript for later nodes).'
              }
            />
          </>
        )}
      </Box>

      {/* What LATER steps see of this node's work — the output-side counterpart. */}
      <Box sx={{ mb: 1 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          What do later steps see of this step&apos;s work?
        </Typography>
        <Box role="radiogroup" aria-label="Model output" sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
          <OptionCard
            selected={outputMode === 'full-conversation'}
            onClick={() => setOutputMode('full-conversation')}
            icon={<ForumOutlinedIcon fontSize="small" />}
            title="Full conversation"
            description="Later steps see everything this step did — tool calls, tool results, and intermediate turns. The default."
          />
          <OptionCard
            selected={outputMode === 'latest-message'}
            onClick={() => setOutputMode('latest-message')}
            icon={<ChatBubbleOutlineIcon fontSize="small" />}
            title="Latest message only"
            description="Later steps see only this step's final response. Its tool calls and results are hidden from later models to save context tokens (they stay visible in the chat and log)."
          />
        </Box>
      </Box>
    </Box>
  );
};

export default PromptIOControls;
