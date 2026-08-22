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
import { Editable, ReactEditor, Slate, useSlate, withReact, type RenderElementProps } from 'slate-react';
import {
  findPromptRefs,
  parsePromptRefPill,
  encodePromptRefPill,
  promptRefLabel,
  PromptRef,
  PromptRefKind,
  PromptReferenceSuggestion,
  createPromptReferenceSuggestion,
  encodeDynamicReference,
} from '@/utils/shared/promptRefs';
import { flowService } from '@/frontend/services/flow';
import { modelService } from '@/frontend/services/model';
import { chatService } from '@/frontend/services/chat';
import { mcpService } from '@/frontend/services/mcp';
import { extractUiResourceUri, isMcpAppMimeType, isUiResourceUri } from '@/shared/utils/mcpApps';
import { getSelectedWorkspace } from '@/frontend/utils/workspaceSelection';
import './PromptBuilder/promptBuilder.css';
import { useI18n } from '@/frontend/contexts/I18nContext';

export interface GlobalReferenceEditorRef {
  insertText: (text: string) => void;
  focus: () => void;
}

export interface GlobalReferenceEditorProps {
  value: string;
  onChange: (value: string) => void;
  globalNames?: string[];
  /** Context-authorized tool/resource/global options for the `@` picker. */
  suggestions?: PromptReferenceSuggestion[];
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
  /** Load the cross-application entity/file hitlist in addition to local refs. */
  enhancedHitlist?: boolean;
  /** Direction in which the completion hitlist opens relative to the editor. */
  hitlistPlacement?: 'top' | 'bottom';
  /** Optional roots used by `@@` file search; configured MCP roots are the fallback. */
  workspaceRoots?: string[];
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

type AtCompletion = GlobalCompletion;

interface ActiveCompletion extends GlobalCompletion {
  range: Range;
  mode: 'at' | 'global';
  items: PromptReferenceSuggestion[];
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

/** Detect an ordinary-text `@query` immediately before the caret. */
export function findAtCompletion(text: string, offset = text.length): AtCompletion | null {
  const prefix = text.slice(0, offset);
  const match = prefix.match(/(?:^|\s)(@@?)([^\s@{}]*)$/);
  if (!match || match.index === undefined) return null;
  const atOffset = match.index + (match[0].startsWith('@') ? 0 : 1);
  return { query: `${match[1] === '@@' ? '@' : ''}${match[2]}`, start: atOffset, end: offset };
}

type HitlistScope = 'all' | 'conversation' | 'flow' | 'model' | 'app' | 'file';

function parseHitlistQuery(query: string): { scope: HitlistScope; query: string } {
  if (query.startsWith('@')) return { scope: 'file', query: query.slice(1) };
  const prefix: Record<string, HitlistScope> = { c: 'conversation', f: 'flow', m: 'model', a: 'app' };
  const scope = prefix[query[0]?.toLocaleLowerCase()];
  return scope ? { scope, query: query.slice(1) } : { scope: 'all', query };
}

function fuzzyScore(haystack: string, needle: string): number | null {
  const text = haystack.toLocaleLowerCase();
  const query = needle.trim().toLocaleLowerCase();
  if (!query) return 0;
  const contiguous = text.indexOf(query);
  if (contiguous >= 0) return contiguous;
  let at = 0;
  let score = 100;
  for (const char of query) {
    const found = text.indexOf(char, at);
    if (found < 0) return null;
    score += found - at;
    at = found + 1;
  }
  return score;
}

export function filterReferenceSuggestions(
  suggestions: PromptReferenceSuggestion[],
  query: string,
): PromptReferenceSuggestion[] {
  const seen = new Set<string>();
  return suggestions
    .map((item) => ({
      item,
      score: fuzzyScore(`${item.label} ${item.name} ${item.server} ${item.description ?? ''} ${item.searchText ?? ''}`, query),
    }))
    .filter(({ item, score }) => {
      if (score === null) return false;
      if (seen.has(item.value)) return false;
      seen.add(item.value);
      return true;
    })
    .sort((a, b) => {
      const kindOrder: Record<PromptRefKind, number> = { tool: 0, resource: 1, global: 2, runres: 3, mention: 4 };
      return (a.score ?? 0) - (b.score ?? 0)
        || kindOrder[a.item.kind] - kindOrder[b.item.kind]
        || a.item.label.localeCompare(b.item.label);
    })
    .map(({ item }) => item);
}

const builtInMentionSuggestions = [
  ['conversation', 'Current conversation'],
  ['flows', 'Current flow'],
  ['node', 'Current node'],
  ['model', 'Current model'],
  ['app', 'Current MCP app/server'],
  ['time', 'Current local time'],
  ['date', 'Current local date'],
  ['folder', 'Current flow folder'],
] as const;

const hitlistCache = new Map<string, { expires: number; suggestions: PromptReferenceSuggestion[]; roots: string[] }>();

function appNameFromUri(uri: string): string {
  const tail = uri.replace(/^ui:\/\//i, '').split('/').filter(Boolean).at(-1);
  if (!tail) return uri;
  try {
    return decodeURIComponent(tail).replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  } catch {
    return tail.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
}

async function loadEnhancedHitlist(): Promise<{ suggestions: PromptReferenceSuggestion[]; roots: string[] }> {
  const workspace = getSelectedWorkspace();
  const cached = hitlistCache.get(workspace);
  if (cached && cached.expires > Date.now()) return cached;
  const [flows, models, conversationPage, configsResult] = await Promise.all([
    flowService.loadFlows().catch(() => []),
    modelService.loadModels().catch(() => []),
    chatService.listConversationPage({ limit: 50 }).catch(() => ({ items: [], total: 0, hasMore: false })),
    mcpService.loadServerConfigs().catch(() => []),
  ]);
  const configs = Array.isArray(configsResult) ? configsResult : [];
  const discoveredApps = (await Promise.all(configs
    .filter((config) => config.disabled !== true && config.enableMcpApps === true)
    .map(async (config) => {
      const [resourceResult, toolResult] = await Promise.all([
        mcpService.listServerResources(config.name).catch(() => ({ resources: [] })),
        mcpService.listServerTools(config.name).catch(() => ({ tools: [] })),
      ]);
      const apps = new Map<string, { name: string; description?: string }>();
      for (const resource of Array.isArray(resourceResult.resources) ? resourceResult.resources : []) {
        if (!isUiResourceUri(resource.uri) || !isMcpAppMimeType(resource.mimeType)) continue;
        apps.set(resource.uri, {
          name: resource.title || resource.name || appNameFromUri(resource.uri),
          description: resource.description,
        });
      }
      for (const tool of Array.isArray(toolResult.tools) ? toolResult.tools : []) {
        const uri = extractUiResourceUri(tool._meta);
        if (uri && !apps.has(uri)) apps.set(uri, { name: appNameFromUri(uri) });
      }
      return [...apps].map(([uri, app]) => ({ ...app, uri, serverName: config.name }));
    }))).flat();
  const suggestions: PromptReferenceSuggestion[] = [
    ...builtInMentionSuggestions.map(([kind, description]) => ({
      kind: 'mention' as const,
      server: '',
      name: `@${kind}`,
      label: `@${kind}`,
      value: `@${kind}`,
      description,
      category: 'builtin' as const,
    })),
    ...flows.map((flow) => ({
      kind: 'mention' as const,
      server: '',
      name: flow.id,
      label: flow.name,
      value: encodeDynamicReference('flows', flow.id),
      description: flow.description || flow.id,
      category: 'flow' as const,
    })),
    ...models.map((model) => ({
      kind: 'mention' as const,
      server: '',
      name: model.id,
      label: model.displayName || model.name,
      value: encodeDynamicReference('model', model.id),
      description: model.description || model.id,
      category: 'model' as const,
    })),
    ...configs.map((config) => ({
      kind: 'mention' as const,
      server: config.name,
      name: config.name,
      label: config.name,
      value: encodeDynamicReference('app', config.name),
      description: 'MCP server',
      category: 'mcpserver' as const,
    })),
    ...discoveredApps.map((app) => ({
      kind: 'mention' as const,
      server: app.serverName,
      name: app.uri,
      label: app.name,
      value: encodeDynamicReference('app', app.uri),
      description: app.description || `${app.serverName} · ${app.uri}`,
      searchText: app.serverName,
      category: 'app' as const,
    })),
    ...conversationPage.items.map((conversation) => ({
      kind: 'mention' as const,
      server: '',
      name: conversation.id,
      label: conversation.title,
      value: encodeDynamicReference('conversation', conversation.id),
      description: conversation.id,
      category: 'conversation' as const,
    })),
  ];
  const roots = [...new Set(configs.flatMap((config) => (
    Array.isArray(config.roots) && config.roots.length > 0 ? config.roots : [config.rootPath]
  )).filter((root): root is string => typeof root === 'string' && root.trim().length > 0))];
  const result = { expires: Date.now() + 30_000, suggestions, roots };
  hitlistCache.set(workspace, result);
  return result;
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

const ReferencePill = ({
  element,
  disabled,
  invalid,
}: {
  element: ReferenceElement;
  disabled: boolean;
  invalid: boolean;
}) => {
  const editor = useSlate();
  const { t } = useI18n();
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
    <span
      contentEditable={false}
      className={`tool-reference-container ${className}${invalid ? ' invalid' : ''}`}
      title={invalid ? t('references.invalid') : undefined}
      aria-invalid={invalid || undefined}
    >
      <span className={`tool-reference ${className}${invalid ? ' invalid' : ''}`}>{promptRefLabel(element)}</span>
      {!disabled && (
        <span
          className={`tool-reference-delete ${className}`}
          role="button"
          aria-label={t('references.remove', { name: promptRefLabel(element) })}
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
  globalNames = [],
  suggestions,
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
  enhancedHitlist = false,
  hitlistPlacement = 'bottom',
  workspaceRoots,
}, ref) => {
  const { t } = useI18n();
  const editor = useMemo(() => withHistory(withReferencePills(withReact(createEditor()))), []);
  const initialValue = useMemo(() => deserializeReferenceValue(value || ''), []);
  const [activeCompletion, setActiveCompletion] = useState<ActiveCompletion | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [revision, setRevision] = useState(0);
  const applyingExternalValue = useRef(false);
  const [enhancedSuggestions, setEnhancedSuggestions] = useState<PromptReferenceSuggestion[]>([]);
  const [configuredRoots, setConfiguredRoots] = useState<string[]>([]);
  const [asyncSuggestions, setAsyncSuggestions] = useState<PromptReferenceSuggestion[]>([]);

  useEffect(() => {
    // Entity/app discovery can fan out to several services. Load it on the
    // first ordinary `@` completion instead of on every mounted prompt field.
    if (!enhancedHitlist || activeCompletion?.mode !== 'at') return;
    let cancelled = false;
    void loadEnhancedHitlist().then((result) => {
      if (cancelled) return;
      setEnhancedSuggestions(result.suggestions);
      setConfiguredRoots(result.roots);
    });
    return () => { cancelled = true; };
  }, [activeCompletion?.mode, enhancedHitlist]);
  const pickerSuggestions = useMemo(() => {
    const globals = globalNames.map((name) => createPromptReferenceSuggestion(
      { kind: 'global', server: '', name },
      name,
    ));
    return filterReferenceSuggestions([...(suggestions ?? []), ...globals, ...enhancedSuggestions], '');
  }, [enhancedSuggestions, globalNames, suggestions]);
  const validatedValues = useMemo(
    () => suggestions ? new Set(pickerSuggestions.map((item) => item.value)) : null,
    [pickerSuggestions, suggestions],
  );

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
    const atCompletion = findAtCompletion(node.text, point.offset);
    const globalCompletion = findGlobalCompletion(node.text, point.offset);
    const completion = atCompletion ?? globalCompletion;
    if (!completion) {
      setActiveCompletion(null);
      return;
    }
    const mode = atCompletion ? 'at' : 'global';
    const parsedQuery = parseHitlistQuery(completion.query);
    const source = mode === 'at'
      ? pickerSuggestions.filter((item) => parsedQuery.scope === 'all'
        || item.category === parsedQuery.scope
        || (parsedQuery.scope === 'file' && item.category === 'folder'))
      : pickerSuggestions.filter((item) => item.kind === 'global');
    const items = filterReferenceSuggestions(source, mode === 'at' ? parsedQuery.query : completion.query);
    setActiveIndex(0);
    setActiveCompletion({
      ...completion,
      mode,
      items,
      range: {
        anchor: { path: point.path, offset: completion.start },
        focus: point,
      },
    });
  }, [editor, pickerSuggestions]);

  useEffect(() => {
    if (!enhancedHitlist || activeCompletion?.mode !== 'at') {
      setAsyncSuggestions([]);
      return;
    }
    const parsed = parseHitlistQuery(activeCompletion.query);
    if ((parsed.scope !== 'conversation' && parsed.scope !== 'file') || !parsed.query.trim()) {
      setAsyncSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (parsed.scope === 'conversation') {
        void chatService.listConversationPage({ limit: 50, search: parsed.query, dimension: 'content' })
          .then((page) => page.items.map((conversation) => ({
            kind: 'mention' as const,
            server: '',
            name: conversation.id,
            label: conversation.title,
            value: encodeDynamicReference('conversation', conversation.id),
            description: conversation.id,
            // The backend matched this query against message content. Preserve
            // that match when the shared fuzzy filter ranks the returned rows.
            searchText: parsed.query,
            category: 'conversation' as const,
          })))
          .then((items) => { if (!cancelled) setAsyncSuggestions(items); })
          .catch(() => { if (!cancelled) setAsyncSuggestions([]); });
        return;
      }
      const roots = workspaceRoots?.length ? workspaceRoots : configuredRoots;
      const params = new URLSearchParams({ q: parsed.query });
      if (roots.length > 0) params.set('roots', JSON.stringify(roots));
      void fetch(`/api/reference-search/files?${params.toString()}`)
        .then((response) => response.ok ? response.json() : { items: [] })
        .then((result) => (Array.isArray(result.items) ? result.items : []).map((item: { path: string; name: string; isDirectory: boolean }) => ({
          kind: 'mention' as const,
          server: '',
          name: item.path,
          label: item.name,
          value: encodeDynamicReference(item.isDirectory ? 'folder' : 'file', item.path),
          description: item.path,
          category: item.isDirectory ? 'folder' as const : 'file' as const,
        })))
        .then((items) => { if (!cancelled) setAsyncSuggestions(items); })
        .catch(() => { if (!cancelled) setAsyncSuggestions([]); });
    }, 160);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [activeCompletion?.mode, activeCompletion?.query, configuredRoots, enhancedHitlist, workspaceRoots]);

  // Refresh an already-open picker when cached entities or async content/file
  // results arrive. This also clears stale remote matches when a later query has
  // no results, without requiring another editor keystroke.
  useEffect(() => {
    if (!activeCompletion) return;
    const parsed = parseHitlistQuery(activeCompletion.query);
    const source = activeCompletion.mode === 'at'
      ? pickerSuggestions.filter((item) => parsed.scope === 'all'
        || item.category === parsed.scope
        || (parsed.scope === 'file' && item.category === 'folder'))
      : pickerSuggestions.filter((item) => item.kind === 'global');
    const remote = activeCompletion.mode === 'at'
      && (parsed.scope === 'conversation' || parsed.scope === 'file')
      ? asyncSuggestions
      : [];
    const items = filterReferenceSuggestions(
      [...source, ...remote],
      activeCompletion.mode === 'at' ? parsed.query : activeCompletion.query,
    );
    setActiveCompletion((current) => {
      if (!current
        || current.mode !== activeCompletion.mode
        || current.query !== activeCompletion.query
        || current.items.length === items.length
          && current.items.every((item, index) => item.value === items[index]?.value)) {
        return current;
      }
      return { ...current, items };
    });
  }, [activeCompletion?.mode, activeCompletion?.query, asyncSuggestions, pickerSuggestions]);

  const chooseSuggestion = useCallback((item: PromptReferenceSuggestion) => {
    if (!activeCompletion) return;
    Transforms.select(editor, activeCompletion.range);
    Transforms.delete(editor);
    const parsed = parsePromptRefPill(item.value);
    if (parsed) insertReference(editor, parsed);
    setActiveCompletion(null);
    ReactEditor.focus(editor);
  }, [activeCompletion, editor]);

  // ReactEditor.focus throws when the editor is not (yet) attached to the DOM, which
  // callers should never have to care about.
  const safeFocus = useCallback(() => {
    try {
      ReactEditor.focus(editor);
    } catch {
      /* editor not mounted */
    }
  }, [editor]);

  useImperativeHandle(ref, () => ({
    insertText: (text: string) => {
      const parsed = parsePromptRefPill(text);
      if (parsed) insertReference(editor, parsed);
      else editor.insertText(text);
      onChange(serializeReferenceValue(editor.children as Descendant[]));
      safeFocus();
    },
    focus: safeFocus,
  }), [editor, onChange, safeFocus]);

  useEffect(() => {
    const current = serializeReferenceValue(editor.children as Descendant[]);
    const normalized = serializeReferenceValue(deserializeReferenceValue(value || ''));
    if (current === normalized) return;
    // Replacing the content from outside used to drop the selection, which blurs the
    // contenteditable — that is what made the chat composer lose focus after every
    // send. When the user is still in the editor we keep focus and park the caret at
    // the end of the new content instead.
    const wasFocused = ReactEditor.isFocused(editor);
    applyingExternalValue.current = true;
    editor.children = deserializeReferenceValue(value || '') as typeof editor.children;
    const end = Editor.end(editor, []);
    editor.selection = wasFocused ? { anchor: end, focus: end } : null;
    editor.onChange();
    setRevision((currentRevision) => currentRevision + 1);
    if (!wasFocused) return;
    // Slate writes the DOM selection in a layout effect; refocus afterwards so the
    // caret is actually visible and the next keystroke lands in the editor.
    const frame = requestAnimationFrame(() => {
      try {
        ReactEditor.focus(editor);
      } catch {
        /* editor unmounted or detached — nothing to focus */
      }
    });
    return () => cancelAnimationFrame(frame);
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
      if (event.key === 'ArrowDown' && activeCompletion.items.length > 0) {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % activeCompletion.items.length);
        return;
      }
      if (event.key === 'ArrowUp' && activeCompletion.items.length > 0) {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + activeCompletion.items.length) % activeCompletion.items.length);
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && activeCompletion.items[activeIndex]) {
        event.preventDefault();
        chooseSuggestion(activeCompletion.items[activeIndex]);
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

  const renderElement = useCallback(({ attributes, children, element }: RenderElementProps) => {
    if (element.type === 'binding-reference') {
      const reference = element as ReferenceElement;
      const serialized = encodePromptRefPill(reference.kind, reference.server, reference.name);
      return (
        <span {...attributes} className="tool-reference-wrapper">
          <ReferencePill
            element={reference}
            disabled={disabled}
            invalid={validatedValues !== null && !validatedValues.has(serialized)}
          />
          {children}
        </span>
      );
    }
    return <p {...attributes}>{children}</p>;
  }, [disabled, validatedValues]);

  const lineHeight = 1.5;
  const editorMinHeight = `${Math.max(1, minRows) * lineHeight}em`;
  const editorMaxHeight = maxRows ? `${Math.max(minRows, maxRows) * lineHeight}em` : undefined;

  return (
    <Box sx={{ position: 'relative', width: '100%', ...containerSx }} data-revision={revision}>
      <Box
        className={bare ? 'global-reference-editor bare' : 'global-reference-editor'}
        // Clicks that land on the frame's padding (not on the text line itself) used to
        // be swallowed, so the first click of a click-to-type looked like it did nothing.
        onMouseDown={(event) => {
          if (disabled) return;
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          try {
            // Focus first: ReactEditor.focus defers itself while the editor has
            // pending operations, so selecting before focusing would only focus a
            // tick later.
            ReactEditor.focus(editor);
            Transforms.select(editor, Editor.end(editor, []));
          } catch {
            /* editor not mounted yet */
          }
        }}
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
          aria-label={activeCompletion.mode === 'at' ? t('references.available') : t('references.globals')}
          sx={{
            position: 'absolute',
            zIndex: 1500,
            ...(hitlistPlacement === 'top'
              ? { bottom: '100%', mb: 0.5 }
              : { top: '100%', mt: 0.5 }),
            left: 0,
            right: 0,
            maxHeight: 240,
            overflowY: 'auto',
          }}
        >
          {activeCompletion.items.length === 0 ? (
            <Box sx={{ px: 1.5, py: 1.25 }}>
              <Typography variant="body2" color="text.secondary">{t('references.none')}</Typography>
            </Box>
          ) : activeCompletion.items.map((item, index) => {
            const groupKey = item.category || item.kind;
            const previousGroupKey = activeCompletion.items[index - 1]?.category || activeCompletion.items[index - 1]?.kind;
            const groupLabel = item.category === 'conversation' ? 'Conversations'
              : item.category === 'flow' ? 'Flows'
              : item.category === 'model' ? 'Models'
                  : item.category === 'mcpserver' ? 'MCP servers'
                    : item.category === 'app' ? 'Apps'
                    : item.category === 'file' || item.category === 'folder' ? 'Files & folders'
                      : item.category === 'builtin' ? 'Current context'
                        : item.kind === 'tool'
              ? t('references.tools')
              : item.kind === 'resource'
                ? t('references.resources')
                : item.kind === 'global'
                  ? t('references.globals')
                  : t('references.temporaryData');
            return (
              <React.Fragment key={item.value}>
                {groupKey !== previousGroupKey && (
                  <Typography
                    component="div"
                    variant="overline"
                    sx={{ px: 1.5, pt: index === 0 ? 0.75 : 1.25, color: 'text.secondary' }}
                  >
                    {groupLabel}
                  </Typography>
                )}
                <Box
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    chooseSuggestion(item);
                  }}
                  sx={{
                    px: 1.5,
                    py: 1,
                    cursor: 'pointer',
                    bgcolor: index === activeIndex ? 'action.selected' : 'background.paper',
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  <Typography component="div" sx={{ fontFamily: 'monospace', fontSize: 14 }}>
                    {item.label}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
                    {item.description || item.value}
                  </Typography>
                </Box>
              </React.Fragment>
            );
          })}
        </Paper>
      )}
    </Box>
  );
});

GlobalReferenceEditor.displayName = 'GlobalReferenceEditor';

export default GlobalReferenceEditor;
