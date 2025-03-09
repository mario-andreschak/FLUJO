# Offline Audio Transcription Implementation Plan

## Overview
We'll implement a real offline transcription feature using Whisper.js through the @xenova/transformers package. This will replace the current dummy function in `src/frontend/components/Chat/ChatInput.tsx`. We'll also add a new settings section to allow users to choose between different model sizes.

## 1. Project Structure Changes

### 1.1 New Files to Create
- `src/frontend/components/Settings/SpeechRecognitionSettings.tsx` - Settings UI for speech model options
- `src/frontend/services/transcription/index.ts` - Service to handle transcription logic
- `src/frontend/services/transcription/whisperModel.ts` - Whisper model management
- `src/shared/types/settings/speech.ts` - Type definitions for speech settings

### 1.2 Files to Modify
- `src/frontend/components/Chat/ChatInput.tsx` - Update audio recording logic
- `src/frontend/components/Settings/index.tsx` - Add speech recognition settings section
- `package.json` - Add @xenova/transformers dependency
- `src/shared/types/storage/storage.ts` - Add speech settings types

## 2. Dependencies

```bash
npm install @xenova/transformers
```

## 3. Implementation Steps

### 3.1 Create Speech Settings Types

In `src/shared/types/settings/speech.ts`:
```typescript
export type WhisperModelSize = 'tiny' | 'base' | 'small' | 'medium' | 'large';

export interface SpeechRecognitionSettings {
  enabled: boolean;
  modelSize: WhisperModelSize;
  autoDownload: boolean;
  language?: string; // Optional language specification
}
```

### 3.2 Update Storage Types

Modify `src/shared/types/storage/storage.ts` to include speech settings.

### 3.3 Create Whisper Model Service

In `src/frontend/services/transcription/whisperModel.ts`:
- Implement model downloading and caching
- Handle model loading states
- Create transcription function

### 3.4 Create Transcription Service

In `src/frontend/services/transcription/index.ts`:
- Create a wrapper service for transcription logic
- Handle error cases and provide status updates

### 3.5 Create Speech Recognition Settings Component

In `src/frontend/components/Settings/SpeechRecognitionSettings.tsx`:
- Create UI for selecting model size
- Add options for auto-download
- Include information about model sizes and requirements

### 3.6 Update Settings Component

Modify `src/frontend/components/Settings/index.tsx` to include the new Speech Recognition settings panel.

### 3.7 Update ChatInput Component

Modify `src/frontend/components/Chat/ChatInput.tsx` to:
- Use the Whisper transcription service
- Handle loading states
- Display transcription results

## 4. Detailed Implementation

### 4.1 Speech Recognition Settings Component

The settings component will include:
- Model size selection (tiny, base, small, medium, large)
- Information about each model size and its requirements
- Option to pre-download models
- Progress indicators for downloads

### 4.2 Whisper Model Service

The service will:
- Lazily load models when needed
- Cache models in IndexedDB
- Provide progress feedback during downloads
- Handle transcription processing

### 4.3 ChatInput Component Changes

The updated component will:
- Use selected model size from settings
- Show appropriate loading indicators during transcription
- Handle errors gracefully
- Update UI based on transcription state

## 5. User Experience Considerations

- Show download progress when models are being downloaded
- Provide clear feedback during transcription processing
- Show helpful error messages if transcription fails
- Allow cancellation of long-running operations

## 6. Future Enhancements

- Support for multiple languages
- Fine-tuning options for accuracy
- Transcription history
- Ability to edit transcriptions before adding to chat