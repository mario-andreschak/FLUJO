import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Editor, Transforms, type BaseEditor } from 'slate';
import { type HistoryEditor } from 'slate-history';
import { type ReactEditor } from 'slate-react';
import GlobalReferenceEditor, {
  serializeReferenceValue,
} from '@/frontend/components/shared/GlobalReferenceEditor';

let mockEditor: BaseEditor & ReactEditor & HistoryEditor;

jest.mock('slate-react', () => {
  const actual = jest.requireActual('slate-react');
  return {
    ...actual,
    // Capture the real editor without replacing its paste/history behavior.
    withReact: (editor: BaseEditor) => {
      mockEditor = actual.withReact(editor);
      return mockEditor;
    },
  };
});

const plainClipboard = (text: string) => ({
  getData: (format: string) => format === 'text/plain' ? text : '',
  types: ['text/plain'],
  files: [],
}) as unknown as DataTransfer;

// Slate clears each frame's operations in a microtask. Separate user actions
// must cross that boundary for history grouping to match browser behavior.
const edit = async (action: () => void) => {
  await act(async () => {
    action();
    await Promise.resolve();
  });
};

describe('GlobalReferenceEditor paste and undo', () => {
  it('undoes a new paste after undo without erasing the earlier text (#5866)', async () => {
    const onChange = jest.fn();
    render(<GlobalReferenceEditor value="" onChange={onChange} ariaLabel="composer" />);

    await edit(() => {
      Transforms.select(mockEditor, Editor.start(mockEditor, []));
      mockEditor.insertText('First');
    });
    await edit(() => {
      mockEditor.insertBreak();
      mockEditor.insertText('Second');
    });
    expect(serializeReferenceValue(mockEditor.children)).toBe('First\nSecond');

    await edit(() => mockEditor.undo());
    expect(serializeReferenceValue(mockEditor.children)).toBe('First');

    // The upstream bug treated this selection-only frame as proof that the
    // previous saved edit belonged to the frame, merging the new paste into it.
    await edit(() => {
      Transforms.select(mockEditor, Editor.start(mockEditor, []));
      mockEditor.insertData(plainClipboard('New '));
    });
    expect(serializeReferenceValue(mockEditor.children)).toBe('New First');
    expect(mockEditor.history.redos).toHaveLength(0);
    expect(mockEditor.history.undos).toHaveLength(2);

    await edit(() => mockEditor.undo());
    expect(serializeReferenceValue(mockEditor.children)).toBe('First');
    expect(onChange).toHaveBeenLastCalledWith('First');
    expect(screen.getByRole('textbox')).toHaveTextContent('First');

    await edit(() => mockEditor.redo());
    expect(serializeReferenceValue(mockEditor.children)).toBe('New First');
    expect(onChange).toHaveBeenLastCalledWith('New First');
  });

  it('pastes mixed references through the real editor and undoes/redoes the whole paste', async () => {
    const onChange = jest.fn();
    render(<GlobalReferenceEditor value="Keep " onChange={onChange}
      globalNames={['API_KEY']} ariaLabel="composer" />);
    const pasted = 'Use ${global:API_KEY}\n${tool:files__read}';

    await edit(() => {
      Transforms.select(mockEditor, Editor.end(mockEditor, []));
      mockEditor.insertData(plainClipboard(pasted));
    });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(`Keep ${pasted}`));
    expect(screen.getByRole('button', { name: 'Remove global:API_KEY' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove tool:files__read' })).toBeInTheDocument();

    await edit(() => mockEditor.undo());
    expect(serializeReferenceValue(mockEditor.children)).toBe('Keep ');
    expect(screen.queryByRole('button', { name: 'Remove global:API_KEY' })).not.toBeInTheDocument();

    await edit(() => mockEditor.redo());
    expect(serializeReferenceValue(mockEditor.children)).toBe(`Keep ${pasted}`);
    expect(screen.getByRole('button', { name: 'Remove global:API_KEY' })).toBeInTheDocument();
  });

  it('ignores an untrusted synthetic paste without changing the prompt or its history', async () => {
    const onChange = jest.fn();
    render(<GlobalReferenceEditor value="Keep this" onChange={onChange} ariaLabel="composer" />);
    const textbox = screen.getByRole('textbox');
    Object.defineProperty(textbox, 'isContentEditable', { value: true });
    await edit(() => Transforms.select(mockEditor, Editor.end(mockEditor, [])));
    onChange.mockClear();

    await edit(() => {
      fireEvent.paste(textbox, { clipboardData: plainClipboard('Unexpected ${global:API_KEY}') });
    });
    expect(serializeReferenceValue(mockEditor.children)).toBe('Keep this');
    expect(mockEditor.history.undos).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Remove global:API_KEY' })).not.toBeInTheDocument();
  });
});
