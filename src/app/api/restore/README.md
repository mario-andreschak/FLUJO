# Restore API

This directory contains the API endpoint for restoring application data from backup archives, including storage files and MCP server repositories.

## Architecture

The Restore API follows a simple architecture:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│  Frontend       │◄───►│  API Layer      │◄───►│  Storage        │
│  Components     │     │  (route.ts)     │     │  Files          │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │                 │
                        │  JSZip Library  │
                        │                 │
                        └─────────────────┘
```

## Components

### API Handler

- `route.ts`: Handles HTTP POST requests to restore application data from backup archives

### Integration with Other Services

- **Storage Utilities**: Writes restored data to storage files
- **JSZip Library**: Extracts data from ZIP archives

## Flow of Control

1. Frontend components make a POST request with the backup file and selections of what to restore
2. API handler validates the backup file and selections
3. API handler extracts the backup metadata and verifies it
4. For each selected item, the API extracts and restores the corresponding data
5. The API returns a success response when the restore is complete

## API Endpoints

### POST /api/restore

Restores application data from a backup archive.

#### Request Body

The request must be sent as `multipart/form-data` with the following fields:

- `file`: The backup ZIP file
- `selections`: JSON string array of items to restore

Example selections:

```json
[
  "models",
  "mcpServers",
  "flows",
  "chatHistory",
  "settings",
  "globalEnvVars",
  "encryptionKey",
  "mcpServersFolder"
]
```

The `selections` array can include any combination of the following items:
- `models`: Model configurations
- `mcpServers`: MCP server configurations
- `flows`: Flow definitions
- `chatHistory`: Chat history records
- `settings`: Application settings
- `globalEnvVars`: Global environment variables
- `encryptionKey`: Encryption key data
- `mcpServersFolder`: The entire MCP servers directory (including source code)

#### Response

```json
{
  "success": true
}
```

## Restore Process

### Validation

Before restoring data, the API performs several validation steps:

1. Verifies that the file is a valid ZIP archive
2. Checks for the presence of `backup-info.json` metadata
3. Validates the structure of the backup

### Storage Files

For each selected storage item, the API:

1. Extracts the corresponding JSON file from the `storage/` directory
2. Parses the JSON data
3. Saves the data to the appropriate storage file using the `saveItem` utility

### MCP Servers Folder

If selected, the API restores the MCP servers folder by:

1. Creating the target directory if it doesn't exist
2. Extracting all files and directories from the `mcp-servers/` directory in the backup
3. Writing each file to the corresponding location in the target directory

## Error Handling

The API returns appropriate HTTP status codes and error messages:

- `400 Bad Request`: Missing or invalid file or selections
- `500 Internal Server Error`: Server-side errors

Error responses include a descriptive message:

```json
{
  "error": "Error message"
}
```

## Usage Examples

### Restore from a Backup

```typescript
// Create a FormData object
const formData = new FormData();

// Add the backup file
formData.append('file', backupFile);

// Add the selections
formData.append('selections', JSON.stringify([
  'models', 
  'flows', 
  'mcpServers', 
  'settings'
]));

// Send the restore request
const response = await fetch('/api/restore', {
  method: 'POST',
  body: formData
});

if (response.ok) {
  const data = await response.json();
  console.log('Restore completed successfully');
} else {
  const errorData = await response.json();
  console.error(`Error restoring from backup: ${errorData.error}`);
}
```

## Security Considerations

### Data Integrity

The restore process includes several safeguards:

1. **Metadata Validation**: Ensures the backup file contains valid metadata
2. **Selective Restore**: Allows users to choose which components to restore
3. **Directory Protection**: Creates directories as needed without overwriting existing files unnecessarily

### Sensitive Data

When restoring sensitive data:

1. **Encryption Keys**: Restoring encryption keys will replace the current encryption system
2. **Environment Variables**: Encrypted environment variables will be restored as-is
3. **User Notification**: Users should be informed about the implications of restoring sensitive data

### File Size and Content

To prevent security issues:

1. The API processes the backup file in memory, which may limit the size of backups that can be restored
2. Files are validated before being written to the filesystem
