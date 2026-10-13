// jsdom-project setup (setupFilesAfterEnv).
//
// Registers @testing-library/jest-dom's custom matchers (toBeInTheDocument,
// toHaveTextContent, ...) for the component/render tests that run under the
// jsdom project. See issue #176 for why the jsdom project exists.
import '@testing-library/jest-dom';
import { TransformStream } from 'node:stream/web';

// SDK2 loads eventsource-parser's browser stream adapter during import. jsdom
// does not supply this platform API; use the supported Node runtime's version.
if (typeof globalThis.TransformStream === 'undefined') {
  Object.defineProperty(globalThis, 'TransformStream', { value: TransformStream, configurable: true, writable: true });
}
