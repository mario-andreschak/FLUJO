/**
 * Component tests for the Signal Node properties modal (issues #117 / #164,
 * coverage gap tracked by #205).
 *
 * The signal modal is intentionally minimal: the only required field is the
 * Signal Name (topic), the node's display label mirrors that name, and the
 * optional payload template lives behind an "Advanced" disclosure. These tests
 * pin the deterministically checkable behaviour under jsdom:
 *  - a fresh node opens with empty topic + payload and Save derives label 'Signal';
 *  - the topic is trimmed and becomes the node label on save;
 *  - a node that already carries a payload opens with Advanced expanded;
 *  - editing the payload behind Advanced persists it into properties;
 *  - re-opening a saved node re-populates topic + payload (round-trip).
 */
import { render, screen, fireEvent } from '@testing-library/react';
import SignalNodePropertiesModal from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/SignalNodePropertiesModal';

const makeNode = (properties: Record<string, any> = {}): any => ({
  id: 's1',
  type: 'signal',
  position: { x: 0, y: 0 },
  data: { label: 'Signal Node', type: 'signal', properties },
});

const renderModal = (node: any, onSave = jest.fn()) => {
  const utils = render(
    <SignalNodePropertiesModal open node={node} onClose={() => {}} onSave={onSave} />
  );
  return { ...utils, onSave };
};

const topicInput = () => screen.getByLabelText(/Signal Name/i) as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: 'Save' });

describe('SignalNodePropertiesModal', () => {
  it('opens a fresh node with empty topic and no payload; Save derives label "Signal"', () => {
    const { onSave } = renderModal(makeNode());
    expect(topicInput().value).toBe('');
    // The payload lives behind a collapsed Advanced disclosure (unmountOnExit).
    expect(screen.queryByLabelText(/Payload template/i)).not.toBeInTheDocument();

    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledTimes(1);
    const [id, data] = onSave.mock.calls[0];
    expect(id).toBe('s1');
    expect(data.label).toBe('Signal');
    expect(data.properties.topic).toBe('');
  });

  it('trims the topic and mirrors it into the node label on save', () => {
    const { onSave } = renderModal(makeNode());
    fireEvent.change(topicInput(), { target: { value: '  review-blocked  ' } });
    fireEvent.click(saveButton());

    const [, data] = onSave.mock.calls[0];
    expect(data.properties.topic).toBe('review-blocked');
    expect(data.label).toBe('review-blocked');
  });

  it('auto-expands the Advanced section when the node already carries a payload', () => {
    renderModal(makeNode({ topic: 'deploy', payloadTemplate: 'v=${var:x}' }));
    const payload = screen.getByLabelText(/Payload template/i) as HTMLInputElement;
    expect(payload).toBeInTheDocument();
    expect(payload.value).toBe('v=${var:x}');
  });

  it('persists a payload template edited behind the Advanced disclosure', () => {
    const { onSave } = renderModal(makeNode({ topic: 'deploy' }));
    // Collapsed for a fresh (payload-less) node — reveal it first.
    expect(screen.queryByLabelText(/Payload template/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Advanced/i }));

    const payload = screen.getByLabelText(/Payload template/i);
    fireEvent.change(payload, { target: { value: 'Blocked: ${var:reviewSummary}' } });
    fireEvent.click(saveButton());

    const [, data] = onSave.mock.calls[0];
    expect(data.properties.topic).toBe('deploy');
    expect(data.properties.payloadTemplate).toBe('Blocked: ${var:reviewSummary}');
  });

  it('round-trips a saved node: re-opening re-populates topic + payload', () => {
    renderModal(makeNode({ topic: 'nightly', payloadTemplate: 'run ${var:id}' }));
    expect(topicInput().value).toBe('nightly');
    // Advanced auto-opens because a payload exists.
    expect((screen.getByLabelText(/Payload template/i) as HTMLInputElement).value).toBe('run ${var:id}');
  });
});
