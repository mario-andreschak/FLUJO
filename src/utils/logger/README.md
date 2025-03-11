# Logger Utility

This directory contains a logging utility for consistent logging across the application.

## Features

- Consistent log format with timestamps and file paths
- Multiple log levels (VERBOSE, DEBUG, INFO, WARN, ERROR)
- Support for logging objects and primitive values
- File-specific logger instances with pre-configured paths
- Normalized file paths for consistent logging
- Per-file log level override capability

## Usage

### Basic Usage

```typescript
import { createLogger } from '@/utils/logger';

// Create a logger instance for this file
const log = createLogger('path/to/component');

// Basic logging
log.verbose('Extremely detailed message');
log.debug('Debug message');
log.info('Info message');
log.warn('Warning message');
log.error('Error message');

// Logging with data
log.debug('Debug message with data', { key: 'value' });
```

### Using with Log Level Override

```typescript
import { createLogger, LOG_LEVEL } from '@/utils/logger';

// Create a logger instance with a custom log level
const log = createLogger('path/to/component', LOG_LEVEL.VERBOSE);

// This will log even if the global log level is higher
log.verbose('Verbose message that will be shown regardless of global setting');
log.debug('Debug message');

// You can create different loggers with different levels in the same file
const criticalLogger = createLogger('path/to/component/critical', LOG_LEVEL.ERROR);
criticalLogger.error('This error will always be logged');
```

## Log Levels

The logger supports the following log levels:

- `VERBOSE` (-1): Extremely detailed information for in-depth debugging
- `DEBUG` (0): Detailed information for debugging purposes
- `INFO` (1): General information about application operation
- `WARN` (2): Warning messages that don't prevent the application from working
- `ERROR` (3): Error messages that may prevent the application from working correctly

The current log level is set in the `features.ts` file. Only messages with a level greater than or equal to the current log level will be displayed.

### Overriding Log Level Per File

You can override the global log level when creating a logger instance:

```typescript
import { createLogger, LOG_LEVEL } from '@/utils/logger';

// Create a logger with a custom log level
const log = createLogger('path/to/component', LOG_LEVEL.VERBOSE);

// This will log even if the global log level is higher
log.verbose('Verbose message');
```

This allows for more granular control over logging in specific parts of your application.

## Best Practices

1. **Use createLogger**: Create a logger instance at the top of each file with the file's path.
2. **Be Consistent**: Use the same path format across the application.
3. **Log Appropriately**: Use the appropriate log level for each message.
4. **Include Context**: Include relevant context in log messages to make them more useful.
5. **Avoid Sensitive Data**: Don't log sensitive data like passwords or tokens.
