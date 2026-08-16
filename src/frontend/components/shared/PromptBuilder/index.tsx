"use client";

import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Box, Paper, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import CodeIcon from '@mui/icons-material/Code';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { mcpService } from '@/frontend/services/mcp';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { createLogger } from '@/utils/logger';
import {
  createPromptReferenceSuggestion,
  findPromptRefs,
  PromptRef,
  PromptRefMatch,
  PromptReferenceSuggestion,
} from '@/utils/shared/promptRefs';
import GlobalReferenceEditor, { GlobalReferenceEditorRef } from '../GlobalReferenceEditor';
import './promptBuilder.css';
import { useI18n } from '@/frontend/contexts/I18nContext';

const log = createLogger('frontend/components/shared/PromptBuilder');

export interface PromptBuilderRef {
  insertText: (text: string) => void;
  getMode: () => 'raw' | 'preview';
}

interface PromptBuilderProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  height?: number | string;
  onModeChange?: (mode: 'raw' | 'preview') => void;
  customPreviewRenderer?: () => React.ReactNode;
  suggestions?: PromptReferenceSuggestion[];
}

const ToolPreview = ({ server, name }: { server: string; name: string }) => {
  const { t } = useI18n();
  const isHandoff = server === 'handoff';
  const [toolInfo, setToolInfo] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetchToolInfo = async () => {
      try {
        setIsLoading(true);
        const result = await mcpService.listServerTools(server);
        const tool = result.tools?.find((candidate: any) => candidate.name === name);
        if (!cancelled) setToolInfo(tool || null);
      } catch (error) {
        log.error(`Failed to fetch tool info for ${server}:${name}`, error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    fetchToolInfo();
    return () => {
      cancelled = true;
    };
  }, [server, name]);

  if (isLoading) {
    return (
      <span className={`tool-reference-preview loading ${isHandoff ? 'handoff' : ''}`}>
        {`tool:${server}__${name}`}
      </span>
    );
  }
  if (!toolInfo) {
    return (
      <span className={`tool-reference-preview not-found ${isHandoff ? 'handoff' : ''}`}>
        {t('promptBuilder.notFound', { reference: `tool:${server}__${name}` })}
      </span>
    );
  }

  return (
    <span className={`tool-reference-preview ${isHandoff ? 'handoff' : ''}`}>
      {t('promptBuilder.toolPreview', {
        kind: t(isHandoff ? 'promptBuilder.kind.handoff' : 'promptBuilder.kind.tool'),
        reference: `tool:${server}__${name}`,
        description: toolInfo.description || t('promptBuilder.noDescription'),
      })}
    </span>
  );
};

const ResourcePreview = ({ server, name }: { server: string; name: string }) => {
  const { t } = useI18n();
  const [description, setDescription] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetchResourceInfo = async () => {
      try {
        setIsLoading(true);
        const result = await mcpService.listServerResources(server);
        const all = [...(result.resources || []), ...(result.resourceTemplates || [])];
        const match = all.find((resource: any) => resource.uri === name || resource.uriTemplate === name);
        if (!cancelled) setDescription(match?.description || match?.name || null);
      } catch (error) {
        log.error(`Failed to fetch resource info for ${server}:${name}`, error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    fetchResourceInfo();
    return () => {
      cancelled = true;
    };
  }, [server, name]);

  if (isLoading) {
    return <span className="tool-reference-preview loading resource">{`resource:${server}__${name}`}</span>;
  }
  return (
    <span className="tool-reference-preview resource">
      {t('promptBuilder.resourcePreview', {
        name,
        server,
        description: description ? ` (${description})` : '',
      })}
    </span>
  );
};

const RunResourcePreview = ({ name }: { name: string }) => {
  const { t } = useI18n();
  return (
    <span className="tool-reference-preview runres">
      {t('promptBuilder.tempPreview', { name })}
    </span>
  );
};

const GlobalPreview = ({ name }: { name: string }) => {
  const { t } = useI18n();
  return (
    <span className="tool-reference-preview global">
      {t('promptBuilder.globalPreview', { reference: `\${global:${name}}` })}
    </span>
  );
};

const BindingPreview = ({ binding }: { binding: PromptRef }) => {
  if (binding.kind === 'global') return <GlobalPreview name={binding.name} />;
  if (binding.kind === 'runres') return <RunResourcePreview name={binding.name} />;
  if (binding.kind === 'resource') return <ResourcePreview server={binding.server} name={binding.name} />;
  return <ToolPreview server={binding.server} name={binding.name} />;
};

const PreviewRenderer = ({ value }: { value: string }) => {
  type Segment =
    | { type: 'text'; value: string }
    | { type: 'binding'; binding: PromptRefMatch; key: number };
  const segments: Segment[] = [];
  let currentIndex = 0;
  for (const match of findPromptRefs(value)) {
    if (match.index > currentIndex) {
      segments.push({ type: 'text', value: value.slice(currentIndex, match.index) });
    }
    segments.push({ type: 'binding', binding: match, key: match.index });
    currentIndex = match.index + match.fullMatch.length;
  }
  if (currentIndex < value.length) {
    segments.push({ type: 'text', value: value.slice(currentIndex) });
  }

  const paragraphs: React.ReactNode[] = [];
  let currentParagraph: React.ReactNode[] = [];
  const flush = () => {
    paragraphs.push(<p key={`p-${paragraphs.length}`}>{currentParagraph}</p>);
    currentParagraph = [];
  };

  for (const segment of segments) {
    if (segment.type === 'text') {
      const lines = segment.value.split('\n');
      for (let index = 0; index < lines.length; index++) {
        currentParagraph.push(lines[index]);
        if (index < lines.length - 1) flush();
      }
    } else {
      currentParagraph.push(<BindingPreview key={`binding-${segment.key}`} binding={segment.binding} />);
    }
  }
  if (currentParagraph.length > 0 || paragraphs.length === 0) flush();

  return <div className="preview-content">{paragraphs}</div>;
};

const PromptBuilder = forwardRef<PromptBuilderRef, PromptBuilderProps>(({
  value,
  onChange,
  label,
  height = 300,
  onModeChange,
  customPreviewRenderer,
  suggestions = [],
}, ref) => {
  const { t } = useI18n();
  const resolvedLabel = label ?? t('promptBuilder.title');
  const { globalEnvVars } = useStorage();
  const globalNames = useMemo(
    () => Object.entries(globalEnvVars)
      .filter(([, entry]) => !entry.metadata?.isSecret)
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b)),
    [globalEnvVars],
  );
  const pickerSuggestions = useMemo(() => [
    ...suggestions,
    ...globalNames.map((name) => createPromptReferenceSuggestion(
      { kind: 'global', server: '', name },
      name,
    )),
  ], [globalNames, suggestions]);
  const editorRef = useRef<GlobalReferenceEditorRef>(null);
  const [mode, setMode] = useState<'raw' | 'preview'>('raw');

  useImperativeHandle(ref, () => ({
    insertText: (text: string) => editorRef.current?.insertText(text),
    getMode: () => mode,
  }), [mode]);

  const handleModeChange = (_event: React.MouseEvent<HTMLElement>, nextMode: 'raw' | 'preview' | null) => {
    if (!nextMode) return;
    setMode(nextMode);
    onModeChange?.(nextMode);
  };

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {resolvedLabel && (
        <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 'medium', mb: 1 }}>
          {resolvedLabel}
        </Typography>
      )}

      <Box sx={{ mb: 1 }}>
        <ToggleButtonGroup value={mode} exclusive onChange={handleModeChange} size="small">
          <ToggleButton value="raw">
            <CodeIcon fontSize="small" sx={{ mr: 0.5 }} />
            {t('promptBuilder.raw')}
          </ToggleButton>
          <ToggleButton value="preview">
            <VisibilityIcon fontSize="small" sx={{ mr: 0.5 }} />
            {t('promptBuilder.preview')}
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Paper
        elevation={0}
        sx={{
          border: '1px solid rgba(0, 0, 0, 0.12)',
          borderRadius: 1,
          overflow: 'visible',
          flexGrow: 1,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {mode === 'raw' ? (
          <Box
            className="slate-editor-container"
            sx={{ height: typeof height === 'number' ? height : '100%', overflow: 'visible', p: 2 }}
          >
            <GlobalReferenceEditor
              ref={editorRef}
              value={value}
              onChange={onChange}
              suggestions={pickerSuggestions}
              enhancedHitlist
              placeholder={t('promptBuilder.placeholder')}
              bare
              minRows={4}
              containerSx={{ height: '100%' }}
              ariaLabel={resolvedLabel || t('promptBuilder.editorAria')}
            />
          </Box>
        ) : customPreviewRenderer ? (
          <Box className="custom-preview-container" sx={{ height: typeof height === 'number' ? height : '100%', overflow: 'auto' }}>
            {customPreviewRenderer()}
          </Box>
        ) : (
          <Box className="preview-container" sx={{ height: typeof height === 'number' ? height : '100%', overflow: 'auto', p: 2 }}>
            <PreviewRenderer value={value} />
          </Box>
        )}
      </Paper>
    </Box>
  );
});

PromptBuilder.displayName = 'PromptBuilder';

export default PromptBuilder;
