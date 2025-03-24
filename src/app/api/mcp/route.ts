import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';

const log = createLogger('app/api/mcp/route');

// Re-export the handlers
export { GET, POST, PUT } from './handlers';

// Re-export the service instance for backward compatibility
export { mcpService };
