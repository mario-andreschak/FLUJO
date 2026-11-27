// What runFlow returns at the end of a run: the error it reports, the final
// text and tool calls, and the decisions of this stretch of the run.
import type { FlowDecision } from '@/utils/shared/decisionRules';
import { TOOL_CALL_ACTION, type ErrorDetails, type SharedState } from '@/backend/execution/flow/types';
import type { ModelMediaPart } from '@/shared/types/model/media';

/** Resuming after an approval starts a new logical run, so each response reports only its own stretch. */
export function decisionsOfThisRun(sharedState: SharedState): FlowDecision[] | undefined {
  const decisions = sharedState.decisionLog?.filter((entry) => entry.runId === sharedState.logicalRunId);
  return decisions?.length ? decisions : undefined;
}

/** The message, details and HTTP status runFlow reports for a run that ended in error. */
export function describeRunError(sharedState: SharedState): { errorMessage: string; errorDetails: ErrorDetails; statusCode: number } {
  let errorMessage = 'Unknown error during execution';
  let errorDetails: ErrorDetails | undefined = undefined;
  let statusCode = 500;

  if (typeof sharedState.lastResponse === 'object' && sharedState.lastResponse !== null) {
    if ('success' in sharedState.lastResponse && sharedState.lastResponse.success === false && 'error' in sharedState.lastResponse && typeof sharedState.lastResponse.error === 'string') {
      errorMessage = sharedState.lastResponse.error;
      if ('errorDetails' in sharedState.lastResponse && typeof sharedState.lastResponse.errorDetails === 'object' && sharedState.lastResponse.errorDetails !== null) {
        const details = sharedState.lastResponse.errorDetails as Partial<ErrorDetails>;
        errorDetails = {
          message: typeof details.message === 'string' ? details.message : errorMessage,
          type: typeof details.type === 'string' ? details.type : undefined,
          code: typeof details.code === 'string' ? details.code : undefined,
          param: typeof details.param === 'string' ? details.param : undefined,
          status: typeof details.status === 'number' ? details.status : undefined,
          stack: typeof details.stack === 'string' ? details.stack : undefined,
          name: typeof details.name === 'string' ? details.name : undefined,
        };
        if (errorDetails.status) {
          statusCode = errorDetails.status;
        }
      }
    } else {
      try {
        errorMessage = `Unexpected error state object: ${JSON.stringify(sharedState.lastResponse)}`;
      } catch {
        errorMessage = 'Unexpected error state object (unserializable)';
      }
    }
  } else if (typeof sharedState.lastResponse === 'string') {
    errorMessage = sharedState.lastResponse;
  }

  if (!errorDetails) {
    errorDetails = { message: errorMessage };
  } else {
    errorDetails.message = errorDetails.message || errorMessage;
  }

  return { errorMessage, errorDetails, statusCode };
}

/** The final text, tool calls and media runFlow returns for a run that did not end in error. */
export function runSuccessOutput(
  sharedState: SharedState,
  currentAction: string | undefined,
  flujo: boolean,
) {
  const lastMessage = sharedState.messages.length > 0 ? sharedState.messages[sharedState.messages.length - 1] : null;

  let responseContent = '';
  let externalToolsXml = '';

  if (typeof sharedState.lastResponse === 'object' && sharedState.lastResponse !== null && '_flujo_xml_tools' in sharedState.lastResponse) {
    externalToolsXml = sharedState.lastResponse._flujo_xml_tools as string;
    if (lastMessage?.role === 'assistant' && typeof lastMessage.content === 'string') {
      responseContent = lastMessage.content;
    } else {
      responseContent = '';
    }
    responseContent += (responseContent ? '\n\n' : '') + externalToolsXml;
    sharedState.lastResponse = responseContent;

  } else if (typeof sharedState.lastResponse === 'string') {
    responseContent = sharedState.lastResponse;
  } else if (lastMessage?.role === 'assistant' && typeof lastMessage.content === 'string') {
    responseContent = lastMessage.content;
  } else {
    responseContent = (currentAction === TOOL_CALL_ACTION && !flujo) ? '' : 'Processing complete.';
  }

  const toolCalls = externalToolsXml
    ? undefined
    : (lastMessage?.role === 'assistant' ? lastMessage.tool_calls : undefined);

  // A child flow may generate media and then finish with a text-only process or
  // handoff message. Returning media only from the literal last message drops
  // those artifacts at the subflow boundary, so SubflowNode never gets a chance
  // to promote them into the parent run. Preserve the most recent assistant
  // artifact set instead; this also naturally prefers a later replacement over
  // an earlier draft without returning every historical attachment.
  let outputMedia: ModelMediaPart[] | undefined;
  for (let i = sharedState.messages.length - 1; i >= 0; i--) {
    const message = sharedState.messages[i];
    if (message.role === 'assistant' && message.media?.length) {
      outputMedia = message.media;
      break;
    }
  }

  return { responseContent, toolCalls, outputMedia };
}
