# Logger Utility

This directory contains a logging utility for consistent logging across the application.

## Features

- Consistent log format with timestamps and file paths
- Multiple log levels (DEBUG, INFO, WARN, ERROR)
- Support for logging objects and primitive values
- File-specific logger instances with pre-configured paths
- Normalized file paths for consistent logging

## Usage

### Basic Usage

```typescript
import { logger } from '@/utils/logger';

// Basic logging
logger.debug('component/path', 'Debug message');
logger.info('component/path', 'Info message');
logger.warn('component/path', 'Warning message');
logger.error('component/path', 'Error message');

// Logging with data
logger.debug('component/path', 'Debug message with data', { key: 'value' });
```

### Recommended Usage with createLogger

```typescript
import { createLogger } from '@/utils/logger';

// Create a logger instance for this file
const log = createLogger('path/to/component');

// Use the logger without specifying the path each time
log.debug('Debug message');
log.info('Info message');
log.warn('Warning message');
log.error('Error message');

// Logging with data
log.debug('Debug message with data', { key: 'value' });
```

## Log Levels

The logger supports the following log levels:

- `DEBUG` (0): Detailed information for debugging purposes
- `INFO` (1): General information about application operation
- `WARN` (2): Warning messages that don't prevent the application from working
- `ERROR` (3): Error messages that may prevent the application from working correctly

The current log level is set in the `logger.ts` file. Only messages with a level greater than or equal to the current log level will be displayed.

## Best Practices

1. **Use createLogger**: Create a logger instance at the top of each file with the file's path.
2. **Be Consistent**: Use the same path format across the application.
3. **Log Appropriately**: Use the appropriate log level for each message.
4. **Include Context**: Include relevant context in log messages to make them more useful.
5. **Avoid Sensitive Data**: Don't log sensitive data like passwords or tokens.
