/** @jest-environment jsdom */

import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import MeetingTranscript from '@/frontend/components/Meetings/MeetingTranscript';
import { DEFAULT_MEETING_POLICY, type MeetingEvent, type MeetingRecord } from '@/shared/types/meeting';
import type { ModelMediaPart } from '@/shared/types/model/media';

const mockTranslations: Record<string, string> = {
  'meetings.transcript.live': 'Live',
  'meetings.transcript.paused': 'Paused',
  'meetings.transcript.errorsOnly': 'Errors',
  'meetings.transcript.motionsOnly': 'Motions',
  'meetings.transcript.clear': 'Clear',
  'meetings.transcript.clearFilters': 'Clear filters',
  'meetings.transcript.shown': '{count} events shown',
  'meetings.transcript.round': 'Round {count}',
  'meetings.transcript.agentError': '{name}: {error}',
  'meetings.transcript.voteCast': 'Vote: {choice}',
  'meetings.transcript.motionResult': 'Motion {outcome}',
  'meetings.transcript.you': 'You',
  'meetings.transcript.waitingTitle': 'Waiting for the conversation',
  'meetings.transcript.waiting': 'Messages will appear when someone speaks.',
  'meetings.transcript.noMatches': 'No matching messages',
  'meetings.transcript.noMatchesHelp': 'Clear the filters to see the conversation.',
};
const mockI18n = {
  t: (key: string, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    mockTranslations[key] ?? key,
  ),
  formatDate: () => '10:00',
};

jest.mock('@/frontend/contexts/I18nContext', () => ({ useI18n: () => mockI18n }));
jest.mock('@/frontend/components/Chat/ChatMarkdown', () => ({
  ChatMarkdownContent: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

// Keep the real react-window List. Only supply the browser layout and observer
// notifications that jsdom lacks, so stale cached bounds remain observable.
type Geometry = { height: number; width: number };
let geometry: WeakMap<Element, Geometry>;
let animationFrames: Map<number, FrameRequestCallback>;
let nextFrameId: number;
let scrollTo: jest.Mock;
const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
let originalResizeObserver: PropertyDescriptor | undefined;

function elementRect(element: HTMLElement): DOMRect {
  const size = geometry.get(element);
  return new DOMRect(0, 0, size?.width ?? 800, size?.height ?? (Number.parseFloat(element.style.height) || 0));
}

class TestResizeObserver implements ResizeObserver {
  static observers = new Set<TestResizeObserver>();
  private targets = new Set<Element>();

  constructor(private callback: ResizeObserverCallback) {
    TestResizeObserver.observers.add(this);
  }

  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() {
    this.targets.clear();
    TestResizeObserver.observers.delete(this);
  }

  static notify(...targets: HTMLElement[]) {
    for (const observer of [...TestResizeObserver.observers]) {
      const entries = targets.filter((target) => observer.targets.has(target)).map((target) => {
        const contentRect = elementRect(target);
        const size = [{ blockSize: contentRect.height, inlineSize: contentRect.width }];
        return { target, contentRect, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size };
      });
      if (entries.length) observer.callback(entries, observer);
    }
  }
}

beforeEach(() => {
  geometry = new WeakMap();
  animationFrames = new Map();
  nextFrameId = 1;
  TestResizeObserver.observers.clear();
  originalResizeObserver = Object.getOwnPropertyDescriptor(window, 'ResizeObserver');
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, writable: true, value: TestResizeObserver });
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return elementRect(this);
  });
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextFrameId++;
    animationFrames.set(id, callback);
    return id;
  });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { animationFrames.delete(id); });
  for (const name of ['clientHeight', 'offsetHeight', 'scrollHeight', 'scrollTo']) {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
  }
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) { return elementRect(this).height; },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) { return Math.round(elementRect(this).height); },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      const sizer = this.querySelector<HTMLElement>('[data-react-window-sizer]');
      return Math.max(this.clientHeight, Number.parseFloat(sizer?.style.height ?? '') || 0);
    },
  });
  scrollTo = jest.fn(function (this: HTMLElement, options: ScrollToOptions | number, y?: number) {
    const top = typeof options === 'number' ? (y ?? 0) : (options.top ?? this.scrollTop);
    this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
    this.dispatchEvent(new Event('scroll'));
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, writable: true, value: scrollTo });
});

afterEach(() => {
  // Disconnect mounted observers before restoring platform properties.
  cleanup();
  jest.restoreAllMocks();
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, name);
  }
  originalDescriptors.clear();
  if (originalResizeObserver) Object.defineProperty(window, 'ResizeObserver', originalResizeObserver);
  else Reflect.deleteProperty(window, 'ResizeObserver');
  TestResizeObserver.observers.clear();
});

function flushAnimationFrames() {
  for (let frame = 0; animationFrames.size > 0 && frame < 10; frame++) {
    act(() => {
      const callbacks = [...animationFrames.values()];
      animationFrames.clear();
      callbacks.forEach((callback) => callback(frame * 16));
    });
  }
}

const meeting: MeetingRecord = {
  version: 1,
  id: 'meeting-transcript',
  title: 'Launch discussion',
  openingPrompt: 'Compare the launch options.',
  status: 'running',
  phase: 'discussion',
  participants: [
    { id: 'alice', name: 'Alice', conversationId: 'conversation-alice', role: 'participant', status: 'idle', lastDeliveredSeq: -1 },
    { id: 'ben', name: 'Ben', conversationId: 'conversation-ben', role: 'participant', status: 'idle', lastDeliveredSeq: -1 },
  ],
  policy: { ...DEFAULT_MEETING_POLICY },
  roundNumber: 1,
  motions: [],
  lastEventSeq: 0,
  createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_000_000,
};

function eventBase(eventId: string, seq = 0) {
  return { version: 1 as const, meetingId: meeting.id, eventId, seq, timestamp: meeting.createdAt + seq * 1000, audience: 'public' as const };
}

function spoke(eventId: string, participantId: 'alice' | 'ben', content: string, media?: ModelMediaPart[]): Extract<MeetingEvent, { type: 'participant:spoke' }> {
  return {
    ...eventBase(eventId), type: 'participant:spoke', participantId,
    participantName: participantId === 'alice' ? 'Alice' : 'Ben', turnId: `turn-${eventId}`, content, media,
  };
}

function intervention(eventId: string, content: string): Extract<MeetingEvent, { type: 'moderator:intervention' }> {
  return { ...eventBase(eventId), type: 'moderator:intervention', content };
}

function rowFor(list: HTMLElement, text: string): HTMLElement {
  const row = within(list).getByText(text).closest<HTMLElement>('[role="listitem"]');
  if (!row) throw new Error(`No accessible virtual row for ${text}`);
  return row;
}

function contentFor(row: HTMLElement): HTMLElement {
  const content = row.firstElementChild;
  if (!(content instanceof HTMLElement)) throw new Error('Missing transcript row content');
  return content;
}

function resizeRows(...measurements: Array<[HTMLElement, number]>) {
  act(() => {
    const contents = measurements.map(([row, height]) => {
      const content = contentFor(row);
      geometry.set(content, { height, width: 800 });
      return content;
    });
    TestResizeObserver.notify(...contents);
  });
}

function pauseFollowing() {
  fireEvent.click(screen.getByRole('button', { name: 'Live' }));
  flushAnimationFrames();
}

describe('MeetingTranscript with react-window v2', () => {
  it('shows the waiting state before the first visible event', () => {
    render(<MeetingTranscript meeting={meeting} events={[]} />);

    expect(screen.getByRole('heading', { name: 'Waiting for the conversation' })).toBeInTheDocument();
    expect(screen.getByText('Messages will appear when someone speaks.')).toBeInTheDocument();
    expect(screen.getByText('0 events shown')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps round headers, error and motion filters, and accessible row positions', () => {
    const roundId = 'round-one';
    const events: MeetingEvent[] = [
      {
        ...eventBase('round-started'), type: 'round:started', roundId,
        round: { id: roundId, number: 1, phase: 'discussion', status: 'running', snapshotSeq: 0, eligibleParticipantIds: ['alice', 'ben'], participantTurnIds: {} },
      },
      { ...spoke('alice-spoke', 'alice', 'Alice recommends a small launch.'), roundId },
      { ...spoke('ben-spoke', 'ben', 'Ben asks for more evidence.'), roundId },
      { ...eventBase('alice-error'), type: 'participant:error', participantId: 'alice', participantName: 'Alice', error: 'Try the connection again.', roundId },
      { ...eventBase('meeting-error'), type: 'meeting:error', error: 'The conversation lost its connection.', roundId },
      {
        ...eventBase('motion-opened'), type: 'motion:opened', roundId,
        motion: { id: 'motion-one', kind: 'finish', proposal: 'Agree on the small launch.', proposedByParticipantId: 'alice', roundId, status: 'open', votes: [], createdAt: meeting.createdAt },
      },
      { ...eventBase('vote-cast'), type: 'vote:cast', motionId: 'motion-one', participantId: 'ben', choice: 'yes', roundId },
      { ...eventBase('motion-resolved'), type: 'motion:resolved', motionId: 'motion-one', outcome: 'accepted', tally: { yes: 2, no: 0, abstain: 0 }, roundId },
    ];
    render(<MeetingTranscript meeting={meeting} events={events} />);
    pauseFollowing();

    const list = screen.getByRole('list');
    const initialRows = within(list).getAllByRole('listitem');
    expect(initialRows).toHaveLength(7);
    initialRows.forEach((row, index) => {
      expect(row).toHaveAttribute('aria-posinset', String(index + 1));
      expect(row).toHaveAttribute('aria-setsize', '7');
    });
    expect(within(list).getByText('Round 1')).toBeInTheDocument();
    expect(screen.getByText('6 events shown')).toBeInTheDocument();
    expect(within(list).queryByText('Vote: yes')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Errors' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('Alice: Try the connection again.')).toBeInTheDocument();
    expect(within(list).getByText('The conversation lost its connection.')).toBeInTheDocument();
    expect(within(list).queryByText('Alice recommends a small launch.')).not.toBeInTheDocument();
    expect(screen.getByText('2 events shown')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Motions' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(within(list).getByText('Agree on the small launch.')).toBeInTheDocument();
    expect(within(list).getByText('Vote: yes')).toBeInTheDocument();
    expect(within(list).getByText('Motion accepted')).toBeInTheDocument();
    expect(within(list).queryByText('The conversation lost its connection.')).not.toBeInTheDocument();
    expect(screen.getByText('3 events shown')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(within(list).getByText('Ben asks for more evidence.')).toBeInTheDocument();
    expect(screen.getByText('6 events shown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('combines speaker and error filters and recovers from no matches', () => {
    render(<MeetingTranscript meeting={meeting} events={[
      spoke('alice', 'alice', 'Alice has a suggestion.'),
      spoke('ben', 'ben', 'Ben has a question.'),
      { ...eventBase('error'), type: 'participant:error', participantId: 'alice', participantName: 'Alice', error: 'Please reconnect.' },
    ]} />);
    pauseFollowing();

    fireEvent.click(screen.getByRole('button', { name: /^(?:B\s*)?Ben$/ }));
    expect(screen.getByText('1 events shown')).toBeInTheDocument();
    expect(within(screen.getByRole('list')).getByText('Ben has a question.')).toBeInTheDocument();
    expect(within(screen.getByRole('list')).queryByText('Alice has a suggestion.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Errors' }));
    expect(screen.getByRole('heading', { name: 'No matching messages' })).toBeInTheDocument();
    expect(screen.getByText('Clear the filters to see the conversation.')).toBeInTheDocument();
    expect(screen.getByText('0 events shown')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(within(screen.getByRole('list')).getByText('Alice has a suggestion.')).toBeInTheDocument();
    expect(within(screen.getByRole('list')).getByText('Ben has a question.')).toBeInTheDocument();
    expect(screen.getByText('3 events shown')).toBeInTheDocument();
  });

  it('updates later row positions and viewport height when media grows or shrinks', () => {
    render(<MeetingTranscript meeting={meeting} events={[
      spoke('photo', 'alice', 'Here is the launch chart.', [{ type: 'image', name: 'launch-chart.png', url: '/launch-chart.png' }]),
      intervention('after-photo', 'Compare the chart with the previous launch.'),
    ]} />);
    pauseFollowing();
    const list = screen.getByRole('list');
    const photoRow = rowFor(list, 'Here is the launch chart.');
    const nextRow = rowFor(list, 'Compare the chart with the previous launch.');
    expect(within(photoRow).getByRole('img', { name: 'launch-chart.png' })).toBeInTheDocument();

    resizeRows([photoRow, 160.2], [nextRow, 95]);
    expect(photoRow.style.height).toBe('161px');
    expect(nextRow.style.transform).toBe('translateY(161px)');
    expect(list.style.height).toBe('310px');

    // Image loading or markdown wrapping changes the inner content extent;
    // the real List must discard its cached offsets after this notification.
    resizeRows([photoRow, 420.2]);
    fireEvent.load(within(photoRow).getByRole('img', { name: 'launch-chart.png' }));
    expect(photoRow.style.height).toBe('421px');
    expect(nextRow.style.transform).toBe('translateY(421px)');
    expect(list.style.height).toBe('516px');

    resizeRows([photoRow, 100]);
    expect(nextRow.style.transform).toBe('translateY(100px)');
    expect(list.style.height).toBe('310px');
    resizeRows([photoRow, 0]);
    expect(photoRow.style.height).toBe('100px');
    expect(nextRow.style.transform).toBe('translateY(100px)');
  });

  it('preserves surviving event rows and their measured heights as filtering changes indexes', () => {
    render(<MeetingTranscript meeting={meeting} events={[
      spoke('alice-first', 'alice', 'Alice first contribution.'),
      spoke('ben-first', 'ben', 'Ben first contribution.'),
      spoke('alice-second', 'alice', 'Alice second contribution.'),
      spoke('ben-second', 'ben', 'Ben second contribution.'),
    ]} />);
    pauseFollowing();
    const list = screen.getByRole('list');
    const aliceFirst = rowFor(list, 'Alice first contribution.');
    const benFirst = rowFor(list, 'Ben first contribution.');
    const aliceSecond = rowFor(list, 'Alice second contribution.');
    const benSecond = rowFor(list, 'Ben second contribution.');
    resizeRows([aliceFirst, 120], [benFirst, 210], [aliceSecond, 80], [benSecond, 150]);
    expect(benSecond.style.transform).toBe('translateY(410px)');

    fireEvent.click(screen.getByRole('button', { name: /^(?:B\s*)?Ben$/ }));
    expect(rowFor(list, 'Ben first contribution.')).toBe(benFirst);
    expect(rowFor(list, 'Ben second contribution.')).toBe(benSecond);
    expect(benFirst).toHaveAttribute('aria-posinset', '1');
    expect(benSecond).toHaveAttribute('aria-posinset', '2');
    expect(benSecond).toHaveAttribute('aria-setsize', '2');
    expect(benFirst.style.height).toBe('210px');
    expect(benFirst.style.transform).toBe('translateY(0px)');
    expect(benSecond.style.transform).toBe('translateY(210px)');

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(rowFor(list, 'Ben first contribution.')).toBe(benFirst);
    expect(benFirst.style.transform).toBe('translateY(120px)');
    // The virtualizer may remount the last row while its visible range settles.
    // Its current DOM must retain the event's measured size at the new index.
    const returnedBenSecond = rowFor(list, 'Ben second contribution.');
    expect(returnedBenSecond.style.height).toBe('150px');
    expect(returnedBenSecond.style.transform).toBe('translateY(410px)');
  });

  it('collapses all contributions from one speaker and repositions following rows', () => {
    render(<MeetingTranscript meeting={meeting} events={[
      spoke('alice-one', 'alice', 'First detailed suggestion.'),
      spoke('ben-one', 'ben', 'A different suggestion.'),
      spoke('alice-two', 'alice', 'Second detailed suggestion.'),
    ]} />);
    pauseFollowing();
    const list = screen.getByRole('list');
    const first = rowFor(list, 'First detailed suggestion.');
    const middle = rowFor(list, 'A different suggestion.');
    const last = rowFor(list, 'Second detailed suggestion.');
    resizeRows([first, 130], [middle, 90], [last, 180]);

    const firstSummary = within(first).getByRole('button', { name: /Alice/ });
    const lastSummary = within(last).getByRole('button', { name: /Alice/ });
    fireEvent.click(firstSummary);
    expect(firstSummary).toHaveAttribute('aria-expanded', 'false');
    expect(lastSummary).toHaveAttribute('aria-expanded', 'false');
    expect(within(middle).getByRole('button', { name: /Ben/ })).toHaveAttribute('aria-expanded', 'true');
    resizeRows([first, 70], [middle, 90], [last, 70]);
    expect(middle.style.transform).toBe('translateY(70px)');
    expect(last.style.transform).toBe('translateY(160px)');

    fireEvent.click(firstSummary);
    expect(firstSummary).toHaveAttribute('aria-expanded', 'true');
    expect(lastSummary).toHaveAttribute('aria-expanded', 'true');
    resizeRows([first, 145], [middle, 90], [last, 225]);
    expect(middle.style.transform).toBe('translateY(145px)');
    expect(last.style.transform).toBe('translateY(235px)');
  });

  it('invalidates hidden row measurements after a positive container width change', () => {
    const { container } = render(<MeetingTranscript meeting={meeting} events={[
      spoke('alice-width', 'alice', 'Alice content that wraps at phone width.'),
      spoke('ben-width', 'ben', 'Ben content that wraps at phone width.'),
    ]} />);
    pauseFollowing();
    const list = screen.getByRole('list');
    const alice = rowFor(list, 'Alice content that wraps at phone width.');
    const ben = rowFor(list, 'Ben content that wraps at phone width.');
    const estimatedAliceHeight = alice.style.height;
    resizeRows([alice, 480], [ben, 100]);
    const transcript = container.firstElementChild as HTMLElement;

    // Hidden/zero-width layout must not erase a valid measurement.
    act(() => {
      geometry.set(transcript, { height: 0, width: 0 });
      TestResizeObserver.notify(transcript);
    });
    expect(alice.style.height).toBe('480px');

    fireEvent.click(screen.getByRole('button', { name: /^(?:B\s*)?Ben$/ }));
    expect(alice).not.toBeInTheDocument();
    act(() => {
      geometry.set(transcript, { height: 500, width: 360 });
      TestResizeObserver.notify(transcript);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    const returnedAlice = rowFor(list, 'Alice content that wraps at phone width.');
    // Before its new content measurement arrives, use the estimate rather than
    // the cached desktop measurement of a row that was absent during resize.
    expect(returnedAlice.style.height).toBe(estimatedAliceHeight);
    resizeRows([returnedAlice, 390], [rowFor(list, 'Ben content that wraps at phone width.'), 160]);
    expect(rowFor(list, 'Ben content that wraps at phone width.').style.transform).toBe('translateY(390px)');
  });

  it('follows new events in Live mode and preserves the reader position while paused', () => {
    const events = Array.from({ length: 12 }, (_, index) => intervention(`update-${index}`, `Launch update ${index + 1}.`));
    const { rerender } = render(<MeetingTranscript meeting={meeting} events={events} />);
    flushAnimationFrames();
    const list = screen.getByRole('list');
    expect(list.scrollTop).toBeGreaterThan(0);
    expect(within(list).getByText('Launch update 12.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('You: Launch update 12.');

    pauseFollowing();
    act(() => {
      list.scrollTop = 0;
      fireEvent.scroll(list);
    });
    scrollTo.mockClear();
    const extendedEvents = [...events, intervention('update-12', 'Launch update 13.')];
    rerender(<MeetingTranscript meeting={meeting} events={extendedEvents} />);
    flushAnimationFrames();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(list.scrollTop).toBe(0);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Paused' }));
    flushAnimationFrames();
    expect(scrollTo).toHaveBeenCalled();
    expect(list.scrollTop).toBeGreaterThan(0);
    expect(within(list).getByText('Launch update 13.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('You: Launch update 13.');

    const resumedScrollTop = list.scrollTop;
    rerender(<MeetingTranscript meeting={meeting} events={[
      ...extendedEvents, intervention('update-13', 'Launch update 14.'),
    ]} />);
    flushAnimationFrames();
    expect(list.scrollTop).toBeGreaterThan(resumedScrollTop);
    expect(within(list).getByText('Launch update 14.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('You: Launch update 14.');
  });
});
