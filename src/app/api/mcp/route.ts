import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';

const log = createLogger('app/api/mcp/route');

// Start all enabled servers when the backend initializes
// Use setTimeout to ensure this runs after the server is fully initialized
setTimeout(() => {
  log.info('Initializing MCP servers');
  mcpService.startEnabledServers().catch(error => {
    log.error('Failed to start enabled servers:', error);
    // Make sure the flag is reset even if there's an unhandled error
    // This is a safety measure in case the finally block in startEnabledServers doesn't execute
    if (mcpService.isStartingUp()) {
      log.warn('Resetting startup flag after error');
      // Access the private method in emergency situation
      (mcpService as any).setStartingUp(false);
    }
  });
}, 0);

// Re-export the handlers
export { GET, POST, PUT } from './handlers';

// Re-export the service instance for backward compatibility
export { mcpService };
