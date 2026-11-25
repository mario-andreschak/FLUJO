# A file added to a chat is never dropped silently: the model gets its content or a short note, and a model that cannot read a format gets a note or the PDF's text

Enforced by:
- `__tests__/frontend/components/ChatInputAttachments.test.tsx`, `__tests__/model/chatAttachmentModelInput.test.ts`, `__tests__/model/mediaHandoff.test.ts`
