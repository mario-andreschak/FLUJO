import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: mockUseAskFlujo,
  useAskFlujoPage: mockUseAskFlujoPage,
}));

const transcribeMock = jest.fn();
const getUserMediaMock = jest.fn();
const trackStopMock = jest.fn();
let nextChunk = new Blob(['recorded audio'], {
  type: 'audio/webm;codecs=opus',
});
const recorderInstances: MockMediaRecorder[] = [];

jest.mock('@mui/material', () => {
  const actual = jest.requireActual('@mui/material');
  return { ...actual, useMediaQuery: () => false };
});

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({
    settings: {
      speech: {
        enabled: true,
        transcriptionModelId: 'whisper-model',
        language: 'es',
      },
    },
    globalEnvVars: {},
  }),
}));

jest.mock('@/frontend/services/transcription', () => ({
  transcribe: (...args: unknown[]) => transcribeMock(...args),
}));

jest.mock('@/frontend/components/shared/GlobalReferenceEditor', () => ({
  __esModule: true,
  default: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange: (value: string) => void;
    ariaLabel: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

jest.mock('@/frontend/components/Chat/FlowNodePicker', () => ({
  __esModule: true,
  default: () => null,
}));

class MockMediaRecorder {
  static isTypeSupported = jest.fn((mimeType: string) =>
    mimeType === 'audio/webm;codecs=opus');

  state: RecordingState = 'inactive';
  mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType || 'audio/webm';
    recorderInstances.push(this);
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: nextChunk } as BlobEvent);
    queueMicrotask(() => this.onstop?.());
  }
}

class MockFileReader {
  result: string | ArrayBuffer | null = null;
  onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(blob: Blob) {
    this.result = `data:${blob.type};base64,YXVkaW8=`;
    queueMicrotask(() => {
      this.onload?.({ target: this } as unknown as ProgressEvent<FileReader>);
    });
  }

  readAsText() {
    this.result = '';
    queueMicrotask(() => {
      this.onload?.({ target: this } as unknown as ProgressEvent<FileReader>);
    });
  }
}

import ChatInput from '@/frontend/components/Chat/ChatInput';

const startAndStopRecording = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Record audio' }));
  await waitFor(() => expect(recorderInstances).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
};

describe('ChatInput prerecorded audio transcription', () => {
  beforeEach(() => {
    recorderInstances.length = 0;
    nextChunk = new Blob(['recorded audio'], {
      type: 'audio/webm;codecs=opus',
    });
    trackStopMock.mockReset();
    getUserMediaMock.mockReset().mockResolvedValue({
      getTracks: () => [{ stop: trackStopMock }],
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: getUserMediaMock },
    });
    Object.defineProperty(global, 'MediaRecorder', {
      configurable: true,
      value: MockMediaRecorder,
    });
    Object.defineProperty(global, 'FileReader', {
      configurable: true,
      value: MockFileReader,
    });
    transcribeMock.mockReset().mockResolvedValue({
      text: 'provider transcript',
      success: true,
      engine: 'provider',
    });
  });

  it('stops microphone tracks before uploading the recorder Blob', async () => {
    const speechRecognitionConstructor = jest.fn();
    Object.defineProperty(window, 'SpeechRecognition', {
      configurable: true,
      value: speechRecognitionConstructor,
    });
    transcribeMock.mockImplementation(async (blob: Blob) => {
      expect(trackStopMock).toHaveBeenCalledTimes(1);
      return {
        text: 'provider transcript',
        success: true,
        engine: 'provider',
      };
    });

    render(<ChatInput onSendMessage={() => undefined} />);
    await startAndStopRecording();

    await waitFor(() => expect(transcribeMock).toHaveBeenCalledTimes(1));
    const [blob, options] = transcribeMock.mock.calls[0] as [
      Blob,
      { modelId: string; language: string },
    ];
    expect(blob.type).toBe('audio/webm;codecs=opus');
    expect(options).toMatchObject({
      modelId: 'whisper-model',
      language: 'es',
    });
    expect(speechRecognitionConstructor).not.toHaveBeenCalled();
    expect(await screen.findByDisplayValue('provider transcript')).toBeInTheDocument();
  });

  it('rejects a zero-byte recording without calling transcription', async () => {
    nextChunk = new Blob([], { type: 'audio/webm;codecs=opus' });
    render(<ChatInput onSendMessage={() => undefined} />);

    await startAndStopRecording();

    expect(await screen.findByText(
      'The recording contains no audio data. Record a new clip and try again.',
    )).toBeInTheDocument();
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(trackStopMock).toHaveBeenCalledTimes(1);
  });

  it('shows permission failure and releases the recording state', async () => {
    const alertMock = jest.spyOn(window, 'alert').mockImplementation(() => undefined);
    getUserMediaMock.mockRejectedValue(new Error('not allowed'));
    render(<ChatInput onSendMessage={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Record audio' }));

    await waitFor(() => expect(alertMock).toHaveBeenCalledWith(
      'Could not access the microphone. Check its permissions.',
    ));
    expect(screen.getByRole('button', { name: 'Record audio' })).toBeEnabled();
    alertMock.mockRestore();
  });

  it('shows empty output as recoverable and retries the same audio', async () => {
    transcribeMock
      .mockResolvedValueOnce({
        text: '',
        success: false,
        error: 'No speech was detected',
        code: 'empty-transcript',
        engine: 'provider',
      })
      .mockResolvedValueOnce({
        text: 'retry transcript',
        success: true,
        engine: 'provider',
      });
    render(<ChatInput onSendMessage={() => undefined} />);

    await startAndStopRecording();

    expect(await screen.findByText(
      'No speech was detected. Enter a transcript manually or retry.',
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to message' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry transcription' }));

    await waitFor(() => expect(transcribeMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByDisplayValue('retry transcript')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to message' })).toBeEnabled();
  });

  it('aborts processing and ignores a late successful completion after cancel', async () => {
    let resolveTranscription!: (value: unknown) => void;
    transcribeMock.mockImplementation((_blob: Blob, options: { signal: AbortSignal }) =>
      new Promise((resolve) => {
        resolveTranscription = resolve;
        expect(options.signal.aborted).toBe(false);
      }),
    );
    render(<ChatInput onSendMessage={() => undefined} />);

    await startAndStopRecording();
    await waitFor(() => expect(transcribeMock).toHaveBeenCalledTimes(1));
    const signal = transcribeMock.mock.calls[0][1].signal as AbortSignal;

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(signal.aborted).toBe(true);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    resolveTranscription({
      text: 'too late',
      success: true,
      engine: 'provider',
    });
    await Promise.resolve();

    expect(screen.queryByText('too late')).not.toBeInTheDocument();
  });

  it('stops the microphone and recorder when unmounted mid-recording', async () => {
    const { unmount } = render(<ChatInput onSendMessage={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Record audio' }));
    await waitFor(() => expect(recorderInstances).toHaveLength(1));
    unmount();

    expect(trackStopMock).toHaveBeenCalledTimes(1);
    expect(recorderInstances[0].state).toBe('inactive');
    expect(transcribeMock).not.toHaveBeenCalled();
  });
});
