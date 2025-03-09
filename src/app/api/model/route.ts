import { createLogger } from '@/utils/logger';
import { modelService } from '@/backend/services/model';

// Create a logger instance for this file
const log = createLogger('app/api/model/route');

// Export the handlers
export { GET, POST } from './handlers';

// Export the service instance for backward compatibility
export { modelService };
