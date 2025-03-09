# Backup API

This directory contains the API endpoint for creating backups of application data, including storage files and MCP server repositories.

## Architecture

The Backup API follows a simple architecture:

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

- `route.ts`: Handles HTTP POST requests to create backup archives containing selected application data

### Integration with Other Services

- **Storage Utilities**: Accesses storage files to include in the backup
- **JSZip Library**: Creates ZIP archives containing the backup data

## Flow of Control

1. Frontend components make a POST request with selections of what to include in the backup
2. API handler validates the selections
3. API handler creates a new ZIP archive and adds metadata
4. For each selected item, the API reads the corresponding storage file or directory
5. The API generates the ZIP file and returns it as a downloadable attachment

## API Endpoints

### POST /api/backup

Creates a backup of selected application data.

#### Request Body

```json
{
  "selections": [
    "models",
    "mcpServers",
    "flows",
    "chatHistory",
    "settings",
    "globalEnvVars",
    "encryptionKey",
    "mcpServersFolder"
  ]
}
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

The response is a ZIP file with the following headers:

```
Content-Type: application/zip
Content-Disposition: attachment; filename=flujo-backup.zip
```

The ZIP file contains:
- `backup-info.json`: Metadata about the backup
- `storage/`: Directory containing storage files
- `mcp-servers/`: Directory containing MCP server repositories (if selected)

## Backup Structure

### Metadata

The `backup-info.json` file contains metadata about the backup:

```json
{
  "version": "1.0",
  "timestamp": "2025-03-04T14:30:00.000Z",
  "selections": ["models", "flows", "mcpServersFolder"]
}
```

### Storage Files

Storage files are saved in the `storage/` directory with their original filenames:

```
storage/models.json
storage/flows.json
storage/mcp_servers.json
storage/chat_history.json
storage/theme.json
storage/global_env_vars.json
storage/encryption_key.json
```

### MCP Servers Folder

If selected, the MCP servers folder is saved in the `mcp-servers/` directory, excluding:
- `node_modules/` directories
- `.git/` directories
- Files larger than 10MB

## Error Handling

The API returns appropriate HTTP status codes and error messages:

- `400 Bad Request`: Missing or invalid selections
- `500 Internal Server Error`: Server-side errors

Error responses include a descriptive message:

```json
{
  "error": "Error message"
}
```

## Usage Examples

### Create a Backup

```typescript
// Create a backup with selected items
const response = await fetch('/api/backup', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    selections: ['models', 'flows', 'mcpServers', 'settings']
  })
});

if (response.ok) {
  // Convert the response to a blob
  const blob = await response.blob();
  
  // Create a download link
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'flujo-backup.zip';
  
  // Trigger the download
  document.body.appendChild(a);
  a.click();
  
  // Clean up
  window.URL.revokeObjectURL(url);
  document.body.removeChild(a);
} else {
  const errorData = await response.json();
  console.error(`Error creating backup: ${errorData.error}`);
}
```

## Security Considerations

### Sensitive Data

The backup may contain sensitive information:

1. **Encryption Keys**: If selected, the backup includes encryption keys
2. **API Keys**: Environment variables may contain API keys
3. **Credentials**: MCP server configurations may include credentials

Users should be advised to keep backup files secure and consider excluding sensitive data when creating backups for sharing.

### File Size Limitations

To prevent excessive file sizes and potential denial of service:

1. Files larger than 10MB are excluded from MCP server backups
2. `node_modules` and `.git` directories are excluded
