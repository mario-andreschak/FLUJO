"use client";

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Box, Paper, Typography } from '@mui/material';
import {
  BaseEditor,
  createEditor,
  Descendant,
  Editor,
  Node,
  Range,
  Text,
  Transforms,
} from 'slate';
import { withHistory } from 'slate-history';
import { Editable, ReactEditor, Slate, useSlate, withReact } from 'slate-react';
import {
  findPromptRefs,
  parsePromptRefPill,
  encodePromptRefPill,
  promptRefLabel,
  PromptRef,
  PromptRefKind,
} from '@/utils/shared/promptRefs';
import './PromptBuilder/promptBuilder.css';

export interface GlobalReferenceEditorRef {
  insertText: (text: string) => void;
  focus: () => void;
}

export interface GlobalReferenceEditorProps {
  value: string;
  onChange: (value: string) => void;
  globalNames: string[];
  placeholder?: string;
  disabled?: boolean;
  multiline?: boolean;
  minRows?: number;
  maxRows?: number;
  autoFocus?: boolean;
  bare?: boolean;
  ariaLabel?: string;
  dataTour?: string;
  containerSx?: Record<string, unknown>;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: React.ClipboardEvent<HTMLDivElement>) => void;
}

interface ReferenceElement {
  type: 'binding-reference';
  kind: PromptRefKind;
  server: string;
  name: string;
  children: CustomText[];
}

interface ParagraphElement {
  type: 'paragraph';
  children: Array<CustomText | ReferenceElement>;
}

interface CustomText {
  text: string;
}

declare module 'slate' {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor;
    Element: ParagraphElement | ReferenceElement;
    Text: CustomText;
  }
}

interface GlobalCompletion {
  query: string;
  start: number;
  end: number;
}

interface ActiveCompletion extends GlobalCompletion {
  range: Range;
  names: string[];
}

export function findGlobalCompletion(text: string, offset = text.length): GlobalCompletion | null {
  const prefix = text.slice(0, offset);
  const match = prefix.match(/\$\{global:([^{}\r\n]*)$/);
  if (!match || match.index === undefined) return null;
  return { query: match[1], start: match.index, end: offset };
}

export function filterGlobalNames(globalNames: string[], query: string): string[] {
  const lowered = query.toLocaleLowerCase();
  return [...new Set(globalNames)]
    .filter((name) => name.toLocaleLowerCase().includes(lowered))
    .sort((a, b) => a.localeCompare(b));
}

const lineToChildren = (line: string): ParagraphElement['children'] => {
  const matches = findPromptRefs(line);
  if (matches.length === 0) return [{ text: line }];

  const children: ParagraphElement['children'] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index > cursor) children.push({ text: line.slice(cursor, match.index) });
    children.push({
      type: 'binding-reference',
      kind: match.kind,
      server: match.server,
      name: match.name,
      children: [{ text: '' }],
    });
    cursor = match.index + match.fullMatch.length;
  }
  if (cursor < line.length) children.push({ text: line.slice(cursor) });
  return children;
};

export function deserializeReferenceValue(value: string): Descendant[] {
  const nodes = value.split('\n').map((line) => ({
    type: 'paragraph' as const,
    children: lineToChildren(line),
  }));
  return nodes.length > 0 ? nodes : [{ type: 'paragraph', children: [{ text: '' }] }];
}

export function serializeReferenceValue(nodes: Descendant[]): string {
  return nodes
    .map((node) => {
      const paragraph = node as ParagraphElement;
      return (paragraph.children || [])
        .map((child) => {
          if (Text.isText(child)) return child.text;
          return encodePromptRefPill(child.kind, child.server, child.name);
        })
        .join('');
    })
    .join('\n');
}

const referenceNode = (ref: PromptRef): ReferenceElement => ({
  type: 'binding-reference',
  kind: ref.kind,
  server: ref.server,
  name: ref.name,
  children: [{ text: '' }],
});

const insertReference = (editor: Editor, ref: PromptRef) => {
  if (!editor.selection) Transforms.select(editor, Editor.end(editor, []));
  Transforms.insertNodes(editor, referenceNode(ref));
  Transforms.move(editor);
};

const replaceCompletedGlobalBeforeCaret = (editor: Editor) => {
  if (!editor.selection || !Range.isCollapsed(editor.selection)) return;
  const point = editor.selection.anchor;
  const node = Node.get(editor, point.path);
  if (!Text.isText(node)) return;
  const before = node.text.slice(0, point.offset);
  const match = before.match(/\$\{global:([^}\r\n]+)\}$/);
  if (!match || match.index === undefined) return;

  const parsed = parsePromptRefPill(match[0]);
  if (!parsed) return;
  Transforms.select(editor, {
    anchor: { path: point.path, offset: match.index },
    focus: point,
  });
  Transforms.delete(editor);
  insertReference(editor, parsed);
};

const withReferencePills = (editor: BaseEditor & ReactEditor) => {
  const { isInline, isVoid, insertData, insertText } = editor;
  editor.isInline = (element) => element.type === 'binding-reference' || isInline(element);
  editor.isVoid = (element) => element.type === 'binding-reference' || isVoid(element);

  editor.insertText = (text) => {
    insertText(text);
    if (text.includes('}')) replaceCompletedGlobalBeforeCaret(editor);
  };

  editor.insertData = (data) => {
    const text = data.getData('text/plain');
    if (text && findPromptRefs(text).length > 0) {
      Transforms.insertFragment(editor, deserializeReferenceValue(text));
      return;
    }
    insertData(data);
  };

  return editor;
};

const ReferencePill = ({ element, disabled }: { element: ReferenceElement; disabled: boolean }) => {
  const editor = useSlate();
  const handoff = element.kind === 'tool' && element.server === 'handoff';
  const className =
    element.kind === 'global'
      ? 'global'
      : element.kind === 'runres'
        ? 'runres'
        : element.kind === 'resource'
          ? 'resource'
          : handoff
            ? 'handoff'
            : '';

  const remove = () => {
    if (disabled) return;
    Transforms.removeNodes(editor, { at: ReactEditor.findPath(editor, element) });
    ReactEditor.focus(editor);
  };

  return (
    <span contentEditable={false} className={`tool-reference-container ${className}`}>
      <span className={`tool-reference ${className}`}>{promptRefLabel(element)}</span>
      {!disabled && (
        <span
          className={`tool-reference-delete ${className}`}
          role="button"
          aria-label={`Remove ${promptRefLabel(element)}`}
          tabIndex={0}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            remove();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              remove();
            }
          }}
        >
          ×
        </span>
      )}
    </span>
  );
};

const GlobalReferenceEditor = forwardRef<GlobalReferenceEditorRef, GlobalReferenceEditorProps>(({
  value,
  onChange,
  globalNames,
  placeholder,
  disabled = false,
  multiline = true,
  minRows = 1,
  maxRows,
  autoFocus = false,
  bare = false,
  ariaLabel,
  dataTour,
  containerSx,
  onKeyDown,
  onPaste,
}, ref) => {
  const editor = useMemo(() => withHistory(withReferencePills(withReact(createEditor()))), []);
  const initialValue = useMemo(() => deserializeReferenceValue(value || ''), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [activeCompletion, setActiveCompletion] = useState<ActiveCompletion | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [revision, setRevision] = useState(0);
  const applyingExternalValue = useRef(false);

  const updateCompletion = useCallback(() => {
    if (!editor.selection || !Range.isCollapsed(editor.selection)) {
      setActiveCompletion(null);
      return;
    }
    const point = editor.selection.anchor;
    const node = Node.get(editor, point.path);
    if (!Text.isText(node)) {
      setActiveCompletion(null);
      return;
    }
    const completion = findGlobalCompletion(node.text, point.offset);
    if (!completion) {
      setActiveCompletion(null);
      return;
    }
    const names = filterGlobalNames(globalNames, completion.query);
    if (names.length === 0) {
      setActiveCompletion(null);
      return;
    }
    setActiveIndex(0);
    setActiveCompletion({
      ...completion,
      names,
      range: {
        anchor: { path: point.path, offset: completion.start },
        focus: point,
      },
    });
  }, [editor, globalNames]);

  const chooseGlobal = useCallback((name: string) => {
    if (!activeCompletion) return;
    Transforms.select(editor, activeCompletion.range);
    Transforms.delete(editor);
    insertReference(editor, { kind: 'global', server: '', name });
    setActiveCompletion(null);
    ReactEditor.focus(editor);
  }, [activeCompletion, editor]);

  useImperativeHandle(ref, () => ({
    insertText: (text: string) => {
      const parsed = parsePromptRefPill(text);
      if (parsed) insertReference(editor, parsed);
      else editor.insertText(text);
      onChange(serializeReferenceValue(editor.children as Descendant[]));
      ReactEditor.focus(editor);
    },
    focus: () => ReactEditor.focus(editor),
  }), [editor, onChange]);

  useEffect(() => {
    const current = serializeReferenceValue(editor.children as Descendant[]);
    const normalized = serializeReferenceValue(deserializeReferenceValue(value || ''));
    if (current === normalized) return;
    applyingExternalValue.current = true;
    editor.children = deserializeReferenceValue(value || '') as typeof editor.children;
    editor.selection = null;
    editor.onChange();
    setRevision((currentRevision) => currentRevision + 1);
  }, [editor, value]);

  const handleChange = useCallback((nodes: Descendant[]) => {
    if (applyingExternalValue.current) {
      applyingExternalValue.current = false;
      return;
    }
    onChange(serializeReferenceValue(nodes));
    updateCompletion();
  }, [onChange, updateCompletion]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (activeCompletion) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % activeCompletion.names.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + activeCompletion.names.length) % activeCompletion.names.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        chooseGlobal(activeCompletion.names[activeIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setActiveCompletion(null);
        return;
      }
    }
    if (!multiline && event.key === 'Enter') {
      event.preventDefault();
      return;
    }
    onKeyDown?.(event);
  };

  const renderElement = useCallback(({ attributes, children, element }: any) => {
    if (element.type === 'binding-reference') {
      return (
        <span {...attributes} className="tool-reference-wrapper">
          <ReferencePill element={element as ReferenceElement} disabled={disabled} />
          {children}
        </span>
      );
    }
    return <p {...attributes}>{children}</p>;
  }, [disabled]);

  const lineHeight = 1.5;
  const editorMinHeight = `${Math.max(1, minRows) * lineHeight}em`;
  const editorMaxHeight = maxRows ? `${Math.max(minRows, maxRows) * lineHeight}em` : undefined;

  return (
    <Box sx={{ position: 'relative', width: '100%', ...containerSx }} data-revision={revision}>
      <Box
        className={bare ? 'global-reference-editor bare' : 'global-reference-editor'}
        sx={{
          border: bare ? 'none' : '1px solid',
          borderColor: 'rgba(0, 0, 0, 0.23)',
          borderRadius: bare ? 0 : 1,
          px: bare ? 0 : 1.75,
          py: bare ? 0 : 1,
          bgcolor: disabled ? 'action.disabledBackground' : 'background.paper',
          '&:focus-within': bare ? {} : { borderColor: 'primary.main', borderWidth: 2, px: '13px', py: '7px' },
        }}
      >
        <Slate editor={editor} initialValue={initialValue} onChange={handleChange}>
          <Editable
            className="slate-editor global-reference-editable"
            renderElement={renderElement}
            placeholder={placeholder}
            readOnly={disabled}
            autoFocus={autoFocus}
            aria-label={ariaLabel}
            data-tour={dataTour}
            role="textbox"
            aria-multiline={multiline}
            onKeyDown={handleKeyDown}
            onPaste={onPaste}
            style={{
              minHeight: editorMinHeight,
              maxHeight: editorMaxHeight,
              overflowY: editorMaxHeight ? 'auto' : undefined,
              whiteSpace: multiline ? 'pre-wrap' : 'nowrap',
            }}
          />
        </Slate>
      </Box>
      {activeCompletion && (
        <Paper
          elevation={8}
          role="listbox"
          aria-label="Global variables"
          sx={{
            position: 'absolute',
            zIndex: 1500,
            top: '100%',
            left: 0,
            right: 0,
            mt: 0.5,
            maxHeight: 240,
            overflowY: 'auto',
          }}
        >
          {activeCompletion.names.map((name, index) => (
            <Box
              key={name}
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(event) => {
                event.preventDefault();
                chooseGlobal(name);
              }}
              sx={{
                px: 1.5,
                py: 1,
                cursor: 'pointer',
                bgcolor: index === activeIndex ? 'action.selected' : 'background.paper',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <Typography component="span" sx={{ fontFamily: 'monospace', fontSize: 14 }}>
                {`\${global:${name}}`}
              </Typography>
            </Box>
          ))}
        </Paper>
      )}
    </Box>
  );
});

GlobalReferenceEditor.displayName = 'GlobalReferenceEditor';

export default GlobalReferenceEditor;
