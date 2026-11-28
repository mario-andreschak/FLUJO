# A file added to a chat is never dropped silently: the model gets its content or a short note, and a model that cannot read a format gets the PDF's text and page pictures, a transcript of the sound, or a note saying why not

Enforced by:
- `__tests__/frontend/components/ChatInputAttachments.test.tsx`, `__tests__/model/chatAttachmentModelInput.test.ts`, `__tests__/model/mediaHandoff.test.ts`
- `__tests__/chat/chatAttachmentLegacyOffice.test.ts`, `__tests__/chat/chatAudioTranscript.test.ts`
