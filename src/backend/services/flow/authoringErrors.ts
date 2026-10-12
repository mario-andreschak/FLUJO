/** Only explicit authoring validation sites may opt into a browser-visible message. */
export class FlowAuthoringValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowAuthoringValidationError';
  }
}
