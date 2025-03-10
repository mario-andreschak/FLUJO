// import { createLogger } from '@/utils/logger';

// const log = createLogger('app/bridge/chat/completions/FlowResponseParser');

// /**
//  * Parses and formats the result from a flow execution into a response content string
//  */
// export function parseFlowResponse(result: any): string {
//   log.debug("parseFlowResponse - Full result", JSON.stringify(result));
  
//   // Initialize retryAttempts in sharedState if it doesn't exist
//   if (result.retryAttempts === undefined) {
//     result.retryAttempts = 0;
//   }

//   // Format tracking information
//   let trackingInfo = '';
//   // Only include tracking info if debug flag is present in messages
//   const hasDebugFlag = result.messages && 
//                        Array.isArray(result.messages) && 
//                        JSON.stringify(result.messages).toUpperCase().includes('~FLUJODEBUG=1');
  
//   if (hasDebugFlag && result.nodeExecutionTracker && Array.isArray(result.nodeExecutionTracker) && result.nodeExecutionTracker.length > 0) {
//     trackingInfo = '## Flow Execution Tracking\n\n';

//     result.nodeExecutionTracker.forEach((node: any) => {
//       trackingInfo += `### Node: ${node.nodeName || 'Unknown'} (Type: ${node.nodeType})\n`;

//       if (node.nodeType === 'ProcessNode') {
//         trackingInfo += `- Model: ${node.modelDisplayName}\n`;
//         trackingInfo += `- Technical Name: ${node.modelTechnicalName}\n`;
//         trackingInfo += `- Allowed Tools: ${node.allowedTools}\n`;
//       }
      
//       if (node.nodeType === 'ModelError') {
//         trackingInfo += `- Error: ${node.error}\n`;
//         if (node.errorDetails) {
//           if (node.errorDetails.name) trackingInfo += `- Error Type: ${node.errorDetails.name}\n`;
//           if (node.errorDetails.message) trackingInfo += `- Message: ${node.errorDetails.message}\n`;
//           if (node.errorDetails.stack) trackingInfo += `- Stack: ${node.errorDetails.stack.split('\n')[0]}\n`;
//         }
//       }

//       trackingInfo += `- Timestamp: ${node.timestamp}\n\n`;
//     });

//     // Add model response information if available
//     if (result.modelResponse) {
//       trackingInfo += '### Model Response Details\n';
//       trackingInfo += `- Success: ${result.modelResponse.success}\n`;
//       if (!result.modelResponse.success) {
//         trackingInfo += `- Error: ${result.modelResponse.error || 'Unknown error'}\n`;
//         if (result.modelResponse.errorDetails) {
//           const details = result.modelResponse.errorDetails;
//           trackingInfo += `- Error Details: ${JSON.stringify(details, null, 2)}\n`;
//         }
//       }
//       trackingInfo += '\n';
//     }

//     trackingInfo += '---\n\n';
//   }

//   // Prepare the result content with tracking information
//   let resultContent = '';
//   let handlingInfo = '';

//   // Log the result content type for debugging
//   log.debug('Result content type:', {
//     type: typeof result.result,
//     isNull: result.result === null,
//     preview: result.result ? (typeof result.result === 'string' ?
//       result.result.substring(0, 100) :
//       JSON.stringify(result.result).substring(0, 100)) : 'empty'
//   });

//   // Handle different types of result.result properly
//   if (result.result === undefined || result.result === null) {
//     // Handle missing result
//     handlingInfo = '## Response Handling: Missing result\n\n';
    
//     // Check if we have modelResponse with error information
//     if (result.modelResponse && !result.modelResponse.success) {
//       handlingInfo += `Error: ${result.modelResponse.error || 'Unknown error'}\n\n`;
//       if (result.modelResponse.errorDetails) {
//         handlingInfo += `Error Details: ${JSON.stringify(result.modelResponse.errorDetails, null, 2)}\n\n`;
//       }
//       resultContent = trackingInfo + handlingInfo + 'Model execution failed. See tracking information for details.';
//     } else {
//       resultContent = trackingInfo + handlingInfo + 'No result was returned from the flow execution.';
//     }
//   } else if (typeof result.result === 'object') {
//     // Handle object result
//     const resultObj = result.result as Record<string, unknown>;
    
//     // Check if it's an error result
//     if ('success' in resultObj && resultObj.success === false && 'error' in resultObj) {
//       // Case 1: Error handling
//       handlingInfo = '## Response Handling: Error detected\n\n';
//       handlingInfo += `Error: ${String(resultObj.error)}\n\n`;
//       if ('errorDetails' in resultObj && resultObj.errorDetails) {
//         handlingInfo += `Error Details: ${JSON.stringify(resultObj.errorDetails, null, 2)}\n\n`;
//       }
//       resultContent = trackingInfo + handlingInfo + JSON.stringify(resultObj, null, 2);
//     } else if ('message' in resultObj) {
//       // Handle message object
//       handlingInfo = '## Response Handling: Message object\n\n';
//       resultContent = trackingInfo + String(resultObj.message);
//     } else {
//       // Other object handling
//       handlingInfo = '## Response Handling: Object response\n\n';
//       resultContent = trackingInfo + handlingInfo + JSON.stringify(resultObj, null, 2);
//     }
//   } else if (typeof result.result === 'string') {
//     // Handle string results
//     // Fix tool call detection - look for the correct pattern
//     const hasToolUse = result.result.includes('-_-_-');
//     const hasFinalResponse = result.result.includes('<final_response>'); // for now: this is only for cline / roo integration.
    
//     if (hasFinalResponse && hasToolUse) {
//       // Case 4: Final response and tool use
//       handlingInfo = '## Response Handling: Mixed final response and tool use\n\n';
//       // Add message to conversation
//       result.messages.push({
//         role: 'user',
//         content: 'Your last message contained a tool call and final_response, you can not mix this.'
//       });
//       // Return updated conversation to model by setting resultContent to the stringified messages
//       resultContent = trackingInfo + handlingInfo + JSON.stringify(result.messages, null, 2);
//     } else if (!hasFinalResponse && !hasToolUse) {
//       // Case 2: No final response, no tool use
//       handlingInfo = '## Response Handling: No final response or tool use detected\n\n';
      
//       // Don't enforce retry attempt logic here - allow the conversation to continue
//       // We'll handle retries only for specific error cases in the API calls
//       resultContent = trackingInfo + handlingInfo + result.result;
      
//       log.debug('Response has no final_response tag or tool use, but continuing without retry', {
//         contentPreview: result.result.substring(0, 100) + (result.result.length > 100 ? '...' : '')
//       });
//     } else if (!hasFinalResponse && hasToolUse) {
//       // Case 3: No final response, but has tool use
//       handlingInfo = '## Response Handling: Tool use detected\n\n';
//       // Let the ProcessNode handle the tool execution
//       resultContent = trackingInfo + handlingInfo + result.result;
      
//       log.info('Tool use detected in response', {
//         hasToolUse,
//         contentPreview: result.result.substring(0, 100) + (result.result.length > 100 ? '...' : '')
//       });
//     } else {
//       // Valid final response without tool use
//       handlingInfo = '## Response Handling: Valid final response\n\n';
//       resultContent = trackingInfo + handlingInfo + result.result;
//     }
//   } else {
//     // Handle other types (number, boolean, etc.)
//     handlingInfo = '## Response Handling: Non-string primitive\n\n';
//     resultContent = trackingInfo + handlingInfo + String(result.result);
//   }

//   log.debug('FINAL RESULT', JSON.stringify(resultContent));
//   log.debug('FINAL TRACKINGINFO', JSON.stringify(trackingInfo));

//   return resultContent;
// }
