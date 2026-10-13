import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import ChatMessages, { type PendingQuestion } from '@/frontend/components/Chat/ChatMessages';
import { I18nProvider } from '@/frontend/contexts/I18nContext';
import { translate } from '@/frontend/i18n/core';
import { SUPPORTED_LOCALES, type SupportedLocale } from '@/frontend/i18n/locales';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));
jest.mock('@/frontend/components/Chat/McpAppFrame', () => ({
  __esModule: true,
  default: () => null,
}));

const question: PendingQuestion = {
  questionId: 'question-1',
  questions: [
    { prompt: 'Pick one', options: ['First', 'Second'] },
    { prompt: 'Pick several', options: ['Red', 'Blue'], multiple: true },
    { prompt: 'Explain your choice', options: ['Type your own answer'], custom: true },
  ],
};
const requiredProps = {
  messages: [],
  onToggleDisabled: jest.fn(),
  onSplitConversation: jest.fn(),
};

function changeLocale(locale: SupportedLocale) {
  fireEvent(window, new StorageEvent('storage', { key: 'flujo.locale', newValue: locale }));
}

describe('pending question and form controls', () => {
  beforeEach(() => { localStorage.clear(); });

  it.each(SUPPORTED_LOCALES.map(({ code }) => code))('names question groups and custom answers in %s', locale => {
    localStorage.setItem('flujo.locale', locale);
    const answer = jest.fn();
    const decline = jest.fn();
    render(<I18nProvider><ChatMessages {...requiredProps} pendingQuestion={question} onAnswerQuestion={answer} onDeclineQuestion={decline} /></I18nProvider>);

    const single = screen.getByRole('radiogroup', { name: 'Pick one' });
    fireEvent.click(within(single).getByRole('radio', { name: 'Second' }));
    const multiple = screen.getByRole('group', { name: 'Pick several' });
    fireEvent.click(within(multiple).getByRole('checkbox', { name: 'Red' }));
    fireEvent.click(within(multiple).getByRole('checkbox', { name: 'Blue' }));
    const custom = screen.getByRole('radiogroup', { name: 'Explain your choice' });
    fireEvent.click(within(custom).getByRole('radio', { name: translate(locale, 'chat.question.custom') }));
    const draft = screen.getByRole('textbox', { name: translate(locale, 'chat.question.answerLabel') });
    fireEvent.change(draft, { target: { value: '  My retained answer  ' } });

    // Changing the display language must not replace a live request or its draft.
    const nextLocale = locale === 'de' ? 'es' : 'de';
    changeLocale(nextLocale);
    expect(screen.getByRole('textbox', { name: translate(nextLocale, 'chat.question.answerLabel') })).toHaveValue('  My retained answer  ');
    fireEvent.click(screen.getByRole('button', { name: translate(nextLocale, 'chat.question.answer') }));
    expect(answer).toHaveBeenCalledWith('question-1', [['Second'], ['Red', 'Blue'], ['My retained answer']]);
    fireEvent.click(screen.getByRole('button', { name: translate(nextLocale, 'chat.question.decline') }));
    expect(decline).toHaveBeenCalledWith('question-1');
  });

  it('keeps independent custom answers under their question names', () => {
    const questions = { questionId: 'many-custom', questions: ['First prompt', 'Second prompt'].map(prompt => ({ prompt, options: ['Type your own answer'], custom: true })) };
    render(<ChatMessages {...requiredProps} pendingQuestion={questions} onAnswerQuestion={jest.fn()} />);
    for (const prompt of ['First prompt', 'Second prompt']) {
      const group = screen.getByRole('group', { name: prompt });
      fireEvent.click(within(group).getByRole('radio', { name: 'Type your own answer' }));
      fireEvent.change(within(group).getByRole('textbox', { name: 'Your answer' }), { target: { value: prompt } });
    }
    expect(within(screen.getByRole('group', { name: 'First prompt' })).getByRole('textbox')).toHaveValue('First prompt');
    expect(within(screen.getByRole('group', { name: 'Second prompt' })).getByRole('textbox')).toHaveValue('Second prompt');
  });

  it('retains a refreshed form draft and its named selector until the request changes', () => {
    const form = { elicitationId: 'form-1', message: 'Choose the destination', requestedSchema: { properties: { destination: { type: 'string', title: 'Destination', enum: ['North', 'South'] }, note: { type: 'string', title: 'Note' } } } };
    const submit = jest.fn();
    const cancel = jest.fn();
    const view = render(<ChatMessages {...requiredProps} pendingElicitation={form} onSubmitElicitation={submit} onCancelElicitation={cancel} />);
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Destination' }));
    fireEvent.click(screen.getByRole('option', { name: 'South' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'Keep this draft' } });
    view.rerender(<ChatMessages {...requiredProps} pendingElicitation={{ ...form }} onSubmitElicitation={submit} onCancelElicitation={cancel} />);
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Keep this draft');
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(submit).toHaveBeenCalledWith('form-1', { destination: 'South', note: 'Keep this draft' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledWith('form-1');
    view.rerender(<ChatMessages {...requiredProps} pendingElicitation={{ ...form, elicitationId: 'form-2' }} onSubmitElicitation={submit} />);
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
  });
});
