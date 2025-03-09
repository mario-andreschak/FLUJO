import { createLogger } from '@/utils/logger';
import { flowService } from '@/backend/services/flow';

// Create a logger instance for this file
const log = createLogger('app/api/flow/route');

// Export the handlers
export { GET, POST } from './handlers';

// Export the service instance for backward compatibility
export { flowService };
