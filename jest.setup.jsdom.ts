// jsdom-project setup (setupFilesAfterEnv).
//
// Registers @testing-library/jest-dom's custom matchers (toBeInTheDocument,
// toHaveTextContent, ...) for the component/render tests that run under the
// jsdom project. See issue #176 for why the jsdom project exists.
import '@testing-library/jest-dom';
