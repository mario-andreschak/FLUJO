"use client";

import React, { useState, useCallback, useMemo, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { createLogger } from '@/utils/logger';

// Create a logger instance for this component
const log = createLogger('frontend/components/shared/PromptBuilder');

// Log levels:
// log.verbose - Extremely detailed information for in-depth debugging
// log.debug - Detailed information for debugging purposes
// log.info - General information about application operation
// log.warn - Warning messages that don't prevent the application from working
// log.error - Error messages that may prevent the application from working correctly
import { createEditor, Descendant, Text, Transforms, Editor, BaseEditor } from 'slate';
import { Slate, Editable, withReact, ReactEditor, useSlate } from 'slate-react';
import { withHistory } from 'slate-history';
import { Box, Typography, Paper, ToggleButtonGroup, ToggleButton } from '@mui/material';
import CodeIcon from '@mui/icons-material/Code';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { mcpService } from '@/frontend/services/mcp';
import './promptBuilder.css';
import {
  BindingKind,
  ParsedBinding,
  encodeBindingPill,
  parsePill,
  findBindings,
  bindingLabel,
} from '@/utils/shared/mcpBinding';

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
}

// A binding reference (tool or resource pill) rendered as an inline void element.
interface BindingReferenceElement {
  type: 'binding-reference';
  kind: BindingKind;
  server: string;
  name: string; // tool name or resource URI
  children: CustomText[];
}

interface CustomElement {
  type: 'paragraph';
  children: (CustomText | BindingReferenceElement)[];
}

interface CustomText {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

declare module 'slate' {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor;
    Element: CustomElement | BindingReferenceElement;
    Text: CustomText;
  }
}

const isHandoffBinding = (b: ParsedBinding): boolean => b.kind === 'tool' && b.server === 'handoff';

// Build the inline children for a single line: plain text interleaved with binding pills.
const lineToChildren = (line: string): CustomElement['children'] => {
  const matches = findBindings(line);
  if (matches.length === 0) {
    return [{ text: line }];
  }

  const children: CustomElement['children'] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.index > cursor) {
      children.push({ text: line.slice(cursor, m.index) });
    }
    children.push({
      type: 'binding-reference',
      kind: m.kind,
      server: m.server,
      name: m.name,
      children: [{ text: '' }],
    });
    cursor = m.index + m.fullMatch.length;
  }
  if (cursor < line.length) {
    children.push({ text: line.slice(cursor) });
  }
  return children;
};

// Convert a markdown string to Slate value
const deserialize = (markdown: string): Descendant[] => {
  log.debug('Deserializing markdown to Slate value');
  const lines = markdown.split('\n');
  const nodes: Descendant[] = lines.map((line) => ({
    type: 'paragraph',
    children: lineToChildren(line),
  }));
  return nodes.length > 0 ? nodes : [{ type: 'paragraph', children: [{ text: '' }] }];
};

// Convert Slate value back to a markdown string
const serialize = (nodes: Descendant[]): string => {
  log.debug('Serializing Slate value to markdown');
  let bindingCount = 0;

  const result = nodes
    .map((node) => {
      const element = node as CustomElement;
      if (!element.children) return '';

      return element.children
        .map((child: any) => {
          if (Text.isText(child)) {
            return child.text;
          } else if (child.type === 'binding-reference') {
            const ref = child as BindingReferenceElement;
            bindingCount++;
            return encodeBindingPill(ref.kind, ref.server, ref.name);
          }
          return '';
        })
        .join('');
    })
    .join('\n');

  if (bindingCount > 0) {
    log.debug(`Serialized ${bindingCount} binding references`);
  }
  return result;
};

// Custom element renderer
const Element = (props: {
  attributes: any;
  children: React.ReactNode;
  element: CustomElement | BindingReferenceElement;
}) => {
  const { attributes, children, element } = props;

  const BindingReferenceComponent = () => {
    const editor = useSlate();
    const ref = element as BindingReferenceElement;
    const handoff = isHandoffBinding(ref);
    const cls = ref.kind === 'resource' ? 'resource' : handoff ? 'handoff' : '';

    const remove = () => {
      const path = ReactEditor.findPath(editor, element);
      log.debug(`Removing binding reference: ${ref.kind}:${ref.server}:${ref.name}`);
      Transforms.removeNodes(editor, { at: path });
    };

    return (
      <span contentEditable={false} className={`tool-reference-container ${cls}`}>
        <span className={`tool-reference ${cls}`}>
          {bindingLabel(ref)}
        </span>
        <span
          className={`tool-reference-delete ${cls}`}
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            remove();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              remove();
            }
          }}
        >
          ×
        </span>
      </span>
    );
  };

  switch (element.type) {
    case 'binding-reference':
      return (
        <span {...attributes} className="tool-reference-wrapper">
          <BindingReferenceComponent />
          {children} {/* Required by Slate */}
        </span>
      );
    default:
      return <p {...attributes}>{children}</p>;
  }
};

// Custom leaf renderer
const Leaf = (props: { attributes: any; children: React.ReactNode; leaf: CustomText }) => {
  const { attributes, children, leaf } = props;
  let formattedChildren = children;

  if (leaf.bold) formattedChildren = <strong>{formattedChildren}</strong>;
  if (leaf.italic) formattedChildren = <em>{formattedChildren}</em>;
  if (leaf.code) formattedChildren = <code>{formattedChildren}</code>;

  return <span {...attributes}>{formattedChildren}</span>;
};

// Preview component for a tool pill — fetches the tool's description.
const ToolPreview = ({ server, name }: { server: string; name: string }) => {
  const isHandoff = server === 'handoff';
  const [toolInfo, setToolInfo] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetchToolInfo = async () => {
      try {
        setIsLoading(true);
        const result = await mcpService.listServerTools(server);
        const tool = result.tools?.find((t: any) => t.name === name);
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
    return <span className={`tool-reference-preview loading ${isHandoff ? 'handoff' : ''}`}>{`tool:${server}__${name}`}</span>;
  }
  if (!toolInfo) {
    return <span className={`tool-reference-preview not-found ${isHandoff ? 'handoff' : ''}`}>{`tool:${server}__${name} (Tool not found)`}</span>;
  }

  return (
    <span className={`tool-reference-preview ${isHandoff ? 'handoff' : ''}`}>
      [The user is referencing a {isHandoff ? 'handoff' : 'tool'} `tool:{server}__{name}` ({toolInfo.description || 'No description'})]
    </span>
  );
};

// Preview component for a resource pill — looks up the resource's description.
const ResourcePreview = ({ server, name }: { server: string; name: string }) => {
  const [desc, setDesc] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetchResourceInfo = async () => {
      try {
        setIsLoading(true);
        const result = await mcpService.listServerResources(server);
        const all = [...(result.resources || []), ...(result.resourceTemplates || [])];
        const match = all.find((r: any) => r.uri === name || r.uriTemplate === name);
        if (!cancelled) setDesc(match?.description || match?.name || null);
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
      [The contents of resource `{name}` from `{server}`{desc ? ` (${desc})` : ''} will be inserted here]
    </span>
  );
};

const BindingPreview = ({ binding }: { binding: ParsedBinding }) =>
  binding.kind === 'resource' ? (
    <ResourcePreview server={binding.server} name={binding.name} />
  ) : (
    <ToolPreview server={binding.server} name={binding.name} />
  );

// Preview renderer for the entire document
const PreviewRenderer = ({ value }: { value: string }) => {
  log.debug('Rendering preview');

  // Build a tagged segment list: text runs and binding pills, in order.
  type Segment = { type: 'text'; value: string } | { type: 'binding'; binding: ParsedBinding; key: number };
  const segments: Segment[] = [];
  let currentIndex = 0;
  for (const m of findBindings(value)) {
    if (m.index > currentIndex) {
      segments.push({ type: 'text', value: value.slice(currentIndex, m.index) });
    }
    segments.push({ type: 'binding', binding: m, key: m.index });
    currentIndex = m.index + m.fullMatch.length;
  }
  if (currentIndex < value.length) {
    segments.push({ type: 'text', value: value.slice(currentIndex) });
  }

  // Assemble paragraphs, splitting text segments on newlines.
  const paragraphs: React.ReactNode[] = [];
  let currentParagraph: React.ReactNode[] = [];
  const flush = () => {
    paragraphs.push(<p key={`p-${paragraphs.length}`}>{currentParagraph}</p>);
    currentParagraph = [];
  };

  for (const segment of segments) {
    if (segment.type === 'text') {
      const lines = segment.value.split('\n');
      for (let i = 0; i < lines.length; i++) {
        currentParagraph.push(lines[i]);
        if (i < lines.length - 1) flush();
      }
    } else {
      currentParagraph.push(<BindingPreview key={`binding-${segment.key}`} binding={segment.binding} />);
    }
  }
  if (currentParagraph.length > 0) flush();

  return <div className="preview-content">{paragraphs}</div>;
};

const PromptBuilder = forwardRef<PromptBuilderRef, PromptBuilderProps>(({
  value,
  onChange,
  label = "Prompt Builder",
  height = 300,
  onModeChange,
  customPreviewRenderer
}, ref) => {
  log.info('PromptBuilder initialized');

  // Create a Slate editor object with custom plugins
  const editor = useMemo(() => {
    const e = withHistory(withReact(createEditor()));
    const { isInline, isVoid } = e;

    // Binding references are inline, void (non-editable) elements.
    e.isInline = (element) => (element.type === 'binding-reference' ? true : isInline(element));
    e.isVoid = (element) => (element.type === 'binding-reference' ? true : isVoid(element));

    return e;
  }, []);

  const [mode, setMode] = useState<'raw' | 'preview'>('raw');
  const [slateValue, setSlateValue] = useState<Descendant[]>(() => deserialize(value || ''));
  const isExternalUpdate = useRef(false);
  const [, setForceUpdate] = useState(0);

  useImperativeHandle(ref, () => ({
    insertText: (text: string) => {
      log.info(`insertText called with text length: ${text.length}`);

      // Is this a complete binding pill (tool or resource)?
      const parsed = parsePill(text);

      if (parsed) {
        log.info(`Inserting ${parsed.kind} reference: ${parsed.server}:${parsed.name}`);
        const bindingReference: BindingReferenceElement = {
          type: 'binding-reference',
          kind: parsed.kind,
          server: parsed.server,
          name: parsed.name,
          children: [{ text: '' }],
        };

        if (!editor.selection) {
          Transforms.select(editor, Editor.end(editor, []));
        }
        Transforms.insertNodes(editor, bindingReference);
        Transforms.move(editor);

        setForceUpdate((prev) => prev + 1);
        setSlateValue([...editor.children] as Descendant[]);
      } else {
        // Regular text
        if (!editor.selection) {
          Transforms.select(editor, Editor.end(editor, []));
        }
        Transforms.insertText(editor, text);
      }

      const newValue = serialize(editor.children as Descendant[]);
      onChange(newValue);
      log.info(`insertText completed successfully`);
    },
    getMode: () => mode
  }));

  // Update Slate value when the external value changes.
  // Compare against the value normalized through the same codec: a saved flow may hold a
  // legacy `${_-_-_..}` pill which serialize() re-emits as `${tool:..}`. Without
  // normalizing, the new text would never equal the legacy value and this effect would
  // re-fire forever. Normalizing makes format-only differences a no-op while still
  // catching genuine external changes (e.g. switching to a different node's template).
  useEffect(() => {
    const currentText = serialize(slateValue);
    const normalizedValue = serialize(deserialize(value || ''));
    if (currentText !== normalizedValue) {
      log.debug('External value change detected');
      isExternalUpdate.current = true;
      setSlateValue(deserialize(value || ''));
    }
  }, [value, slateValue]);

  // Handle changes to the editor content
  const handleChange = useCallback((newValue: Descendant[]) => {
    if (isExternalUpdate.current) {
      isExternalUpdate.current = false;
      return;
    }
    setSlateValue(newValue);
    const markdown = serialize(newValue);
    onChange(markdown);
  }, [onChange]);

  const handleModeChange = (_event: React.MouseEvent<HTMLElement>, newMode: 'raw' | 'preview' | null) => {
    if (newMode !== null) {
      log.info(`Mode changed from ${mode} to ${newMode}`);
      setMode(newMode);
      if (onModeChange) onModeChange(newMode);
    }
  };

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {label && (
        <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 'medium', mb: 1 }}>
          {label}
        </Typography>
      )}

      <Box sx={{ mb: 1 }}>
        <ToggleButtonGroup value={mode} exclusive onChange={handleModeChange} size="small">
          <ToggleButton value="raw">
            <CodeIcon fontSize="small" sx={{ mr: 0.5 }} />
            Raw
          </ToggleButton>
          <ToggleButton value="preview">
            <VisibilityIcon fontSize="small" sx={{ mr: 0.5 }} />
            Preview
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Paper
        elevation={0}
        sx={{
          border: '1px solid rgba(0, 0, 0, 0.12)',
          borderRadius: 1,
          overflow: 'hidden',
          flexGrow: 1,
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        {mode === 'raw' ? (
          <Box className="slate-editor-container" sx={{ height: typeof height === 'number' ? height : '100%', overflow: 'auto', p: 2 }}>
            <Slate editor={editor} initialValue={slateValue} onChange={handleChange}>
              <Editable
                className="slate-editor"
                renderElement={Element}
                renderLeaf={Leaf}
                placeholder="Write your prompt here..."
              />
            </Slate>
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
