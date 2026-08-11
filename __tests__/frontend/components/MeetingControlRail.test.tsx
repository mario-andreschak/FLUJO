import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import MeetingControlRail from '@/frontend/components/Meetings/MeetingControlRail';
import type { MeetingRecord } from '@/shared/types/meeting';

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/PromptTemplateEditor', () => ({
  __esModule: true,
  default: () => null,
}));

function renderRail(status: MeetingRecord['status'], onSteer = jest.fn().mockResolvedValue(undefined)) {
  render(
    <MeetingControlRail
      meeting={{ status, motions: [] } as unknown as MeetingRecord}
      onPrivateNote={jest.fn().mockResolvedValue(undefined)}
      onSteer={onSteer}
      onProposeMotion={jest.fn()}
    />,
  );
  return onSteer;
}

describe('MeetingControlRail', () => {
  it('continues a completed meeting through the steer action', async () => {
    const onSteer = renderRail('completed');
    const composer = screen.getByPlaceholderText('meetings.control.continuePlaceholder');
    const submit = screen.getByRole('button', { name: 'meetings.control.continueWithPrompt' });

    expect(submit).toBeDisabled();
    fireEvent.change(composer, { target: { value: 'Challenge the renderer decision.' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(onSteer).toHaveBeenCalledWith('Challenge the renderer decision.'));
  });

  it('keeps the normal steer action for a live meeting', () => {
    renderRail('running');
    expect(screen.getByRole('button', { name: 'meetings.control.steerPrompt' })).toBeDisabled();
    expect(screen.getByLabelText('meetings.control.composer')).toBeInTheDocument();
  });
});
