"use client";

import React, { useState, useCallback, useMemo, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { createEditor, Descendant, Element as SlateElement, Text, Node, BaseEditor, Transforms, Editor, Range, Point } from 'slate';
import { Slate, Editable, withReact, ReactEditor } from 'slate-react';
import { withHistory } from 'slate-history';
import { Box, Typography, Paper, ToggleButtonGroup, ToggleButton } from '@mui/material';
import CodeIcon from '@mui/icons-material/Code';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { mcpService } from '@/frontend/services/mcp';
import './promptBuilder.css';

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

// Custom types for TypeScript
interface CustomElement {
  type: 'paragraph' | 'tool-reference';
  children: CustomText[];
  serverName?: string;
  toolName?: string;
}

interface CustomText {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  'tool-reference'?: boolean;
  'server-name'?: string;
  'tool-name'?: string;
}

declare module 'slate' {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor;
    Element: CustomElement;
    Text: CustomText;
  }
}

// Tool reference regex pattern
const toolBindingRegex = /\$\{tool:([^:]+):([^}]+)\}/g;

// Convert markdown string to Slate value
const deserialize = (markdown: string): Descendant[] => {
  // Split the markdown into lines
  const lines = markdown.split('\n');
  
  // Create an array of paragraph elements
  const nodes: Descendant[] = [];
  
  for (const line of lines) {
    const remainingLine = line;
    const children: CustomText[] = [];
    
    // Find tool references in the line
    const toolMatches = [...line.matchAll(toolBindingRegex)];
    
    if (toolMatches.length > 0) {
      let lastIndex = 0;
      
      for (const match of toolMatches) {
        const matchIndex = match.index as number;
        
        // Add text before the tool reference
        if (matchIndex > lastIndex) {
          const textBefore = line.slice(lastIndex, matchIndex);
          children.push({ text: textBefore });
        }
        
        // Add the tool reference as a special element
        const serverName = match[1];
        const toolName = match[2];
        
        children.push({
          text: match[0],
          code: true,
          'tool-reference': true,
          'server-name': serverName,
          'tool-name': toolName,
        });
        
        lastIndex = matchIndex + match[0].length;
      }
      
      // Add any remaining text after the last tool reference
      if (lastIndex < line.length) {
        children.push({ text: line.slice(lastIndex) });
      }
    } else {
      // No tool references, just add the line as plain text
      children.push({ text: line });
    }
    
    nodes.push({ type: 'paragraph', children });
  }
  
  return nodes.length > 0 ? nodes : [{ type: 'paragraph', children: [{ text: '' }] }];
};

// Convert Slate value back to markdown string
const serialize = (nodes: Descendant[]): string => {
  return nodes.map(node => {
    const element = node as CustomElement;
    if (!element.children) return '';
    
    return element.children.map((child: CustomText) => {
      if (Text.isText(child)) {
        return child.text;
      }
      return '';
    }).join('');
  }).join('\n');
};

// Custom element renderer
const Element = (props: {
  attributes: any;
  children: React.ReactNode;
  element: CustomElement;
}) => {
  const { attributes, children, element } = props;
  
  switch (element.type) {
    case 'tool-reference':
      return (
        <span 
          {...attributes} 
          className="tool-binding"
        >
          {children}
        </span>
      );
    default:
      return <p {...attributes}>{children}</p>;
  }
};

// Custom leaf renderer
const Leaf = (props: {
  attributes: any;
  children: React.ReactNode;
  leaf: CustomText;
}) => {
  const { attributes, children, leaf } = props;
  
  let formattedChildren = children;
  
  if (leaf.bold) {
    formattedChildren = <strong>{formattedChildren}</strong>;
  }
  
  if (leaf.italic) {
    formattedChildren = <em>{formattedChildren}</em>;
  }
  
  if (leaf.code) {
    formattedChildren = <code className={leaf['tool-reference'] ? 'tool-reference' : ''}>{formattedChildren}</code>;
  }
  
  return <span {...attributes}>{formattedChildren}</span>;
};

// Preview component for rendering tool references
const ToolReferencePreview = ({ serverName, toolName }: { serverName: string, toolName: string }) => {
  const [toolInfo, setToolInfo] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  
  useEffect(() => {
    const fetchToolInfo = async () => {
      try {
        setIsLoading(true);
        const result = await mcpService.listServerTools(serverName);
        if (result.tools) {
          const tool = result.tools.find((t: any) => t.name === toolName);
          if (tool) {
            setToolInfo(tool);
          }
        }
      } catch (error) {
        console.error(`Failed to fetch tool info for ${serverName}:${toolName}`, error);
      } finally {
        setIsLoading(false);
      }
    };
    
    fetchToolInfo();
  }, [serverName, toolName]);
  
  if (isLoading) {
    return <span className="tool-reference-preview loading">{`tool:${serverName}:${toolName}`}</span>;
  }
  
  if (!toolInfo) {
    return <span className="tool-reference-preview not-found">{`tool:${serverName}:${toolName} (Tool not found)`}</span>;
  }
  
  // Format parameters if available
  const paramsText = toolInfo.parameters && toolInfo.parameters.length > 0
    ? ` with parameters ${toolInfo.parameters.map((p: any) => `\`${p.name}\` (${p.description || 'No description'})`).join(', ')}`
    : '';
  
  return (
    <span className="tool-reference-preview">
      [The user is referencing a tool `tool:${serverName}:${toolName}` ({toolInfo.description || 'No description'}){paramsText}]
    </span>
  );
};

// Preview renderer for the entire document
const PreviewRenderer = ({ value }: { value: string }) => {
  // Split the content into segments based on tool references
  const segments: React.ReactNode[] = [];
  let lastIndex = 0;
  
  // Find all tool references in the content
  const matches = [...value.matchAll(toolBindingRegex)];
  
  for (const match of matches) {
    const matchIndex = match.index as number;
    
    // Add text before the tool reference
    if (matchIndex > lastIndex) {
      segments.push(<span key={`text-${lastIndex}`}>{value.slice(lastIndex, matchIndex)}</span>);
    }
    
    // Add the tool reference preview
    const serverName = match[1];
    const toolName = match[2];
    segments.push(
      <ToolReferencePreview 
        key={`tool-${matchIndex}`} 
        serverName={serverName} 
        toolName={toolName} 
      />
    );
    
    lastIndex = matchIndex + match[0].length;
  }
  
  // Add any remaining text after the last tool reference
  if (lastIndex < value.length) {
    segments.push(<span key={`text-${lastIndex}`}>{value.slice(lastIndex)}</span>);
  }
  
  // Split by newlines and create paragraphs
  const paragraphs: React.ReactNode[] = [];
  let currentParagraph: React.ReactNode[] = [];
  
  for (const segment of segments) {
    if (typeof segment === 'string') {
      // Split string segments by newlines
      const lines = segment.split('\n');
      
      for (let i = 0; i < lines.length; i++) {
        currentParagraph.push(lines[i]);
        
        if (i < lines.length - 1) {
          // End of line, create a new paragraph
          paragraphs.push(<p key={`p-${paragraphs.length}`}>{currentParagraph}</p>);
          currentParagraph = [];
        }
      }
    } else {
      // Add React node segments directly
      currentParagraph.push(segment);
    }
  }
  
  // Add the final paragraph if it has content
  if (currentParagraph.length > 0) {
    paragraphs.push(<p key={`p-${paragraphs.length}`}>{currentParagraph}</p>);
  }
  
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
  // Create a Slate editor object that won't change across renders
  const editor = useMemo(() => withHistory(withReact(createEditor())), []);
  
  // State for editor mode (raw or preview)
  const [mode, setMode] = useState<'raw' | 'preview'>('raw');
  
  // Convert the markdown string to Slate's internal format
  const [slateValue, setSlateValue] = useState<Descendant[]>(() => deserialize(value || ''));
  
  // Track if we're handling an external update
  const isExternalUpdate = useRef(false);
  
  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    insertText: (text: string) => {
      // Insert text at the current selection
      if (editor.selection) {
        // If there's a selection, replace it with the text
        Transforms.insertText(editor, text);
      } else {
        // If there's no selection, insert at the end of the document
        Transforms.select(editor, Editor.end(editor, []));
        Transforms.insertText(editor, text);
      }
      
      // Get the updated content as a string
      const newValue = serialize(editor.children as Descendant[]);
      
      // Force a re-processing of the content to properly format tool bindings
      const formattedNodes = deserialize(newValue);
      
      // Replace the entire editor content with the formatted nodes
      Transforms.delete(editor, {
        at: {
          anchor: Editor.start(editor, []),
          focus: Editor.end(editor, []),
        },
      });
      Transforms.insertNodes(editor, formattedNodes);
      
      // Update the value
      onChange(newValue);
    },
    getMode: () => mode
  }));
  
  // Update Slate value when the external value changes
  useEffect(() => {
    // Only update if the value is different from what we already have
    const currentText = serialize(slateValue);
    if (value !== currentText) {
      isExternalUpdate.current = true;
      setSlateValue(deserialize(value || ''));
    }
  }, [value, slateValue]);
  
  // Handle changes to the editor content
  const handleChange = useCallback((newValue: Descendant[]) => {
    // Skip onChange during external updates to avoid loops
    if (isExternalUpdate.current) {
      isExternalUpdate.current = false;
      return;
    }
    
    setSlateValue(newValue);
    const markdown = serialize(newValue);
    onChange(markdown);
  }, [onChange]);
  
  // Handle mode change
  const handleModeChange = (_event: React.MouseEvent<HTMLElement>, newMode: 'raw' | 'preview' | null) => {
    if (newMode !== null) {
      setMode(newMode);
      
      // Call the onModeChange prop if provided
      if (onModeChange) {
        onModeChange(newMode);
      }
    }
  };
  
  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {label && (
        <Typography 
          variant="subtitle1" 
          gutterBottom 
          sx={{ fontWeight: 'medium', mb: 1 }}
        >
          {label}
        </Typography>
      )}
      
      <Box sx={{ mb: 1 }}>
        <ToggleButtonGroup
          value={mode}
          exclusive
          onChange={handleModeChange}
          size="small"
        >
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
          <Box 
            className="slate-editor-container"
            sx={{ 
              height: typeof height === 'number' ? height : '100%',
              overflow: 'auto',
              p: 2
            }}
          >
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
          // Use custom preview renderer if provided
          <Box 
            className="custom-preview-container"
            sx={{ 
              height: typeof height === 'number' ? height : '100%',
              overflow: 'auto'
            }}
          >
            {customPreviewRenderer()}
          </Box>
        ) : (
          // Default preview renderer
          <Box 
            className="preview-container"
            sx={{ 
              height: typeof height === 'number' ? height : '100%',
              overflow: 'auto',
              p: 2
            }}
          >
            <PreviewRenderer value={value} />
          </Box>
        )}
      </Paper>
    </Box>
  );
});

PromptBuilder.displayName = 'PromptBuilder';

export default PromptBuilder;
