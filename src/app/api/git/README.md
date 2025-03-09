# Git Operations API

This directory contains the API layer for Git operations, providing functionality for cloning repositories, running commands, and managing MCP server repositories.

## Architecture

The Git Operations API follows a clean architecture pattern:

```
┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │
│  Frontend       │◄───►│  API Layer      │
│  Components     │     │  (route.ts)     │
└─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │                 │
                        │  Git Operations │
                        │  (simple-git)   │
                        └─────────────────┘
```

## Components

### API Handler

- `route.ts`: Handles HTTP POST requests for various Git operations, including:
  - Cloning repositories
  - Installing dependencies
  - Building projects
  - Running commands
  - Reading files
  - Listing repositories

## Flow of Control

1. Frontend components make POST requests to the API endpoint with specific actions
2. API handler validates the request parameters
3. API handler performs the requested Git operation
4. Results are returned to the frontend

## API Endpoints

The API exposes a single POST endpoint that supports multiple actions:

### Clone Repository

```json
{
  "action": "clone",
  "repoUrl": "https://github.com/username/repo.git",
  "savePath": "/path/to/save/repo",
  "branch": "main" // Optional
}
```

Clones a Git repository to the specified path.

#### Response

```json
{
  "success": true,
  "path": "/path/to/save/repo",
  "relativePath": "/path/to/save/repo",
  "envExample": "EXAMPLE_VAR=value" // Optional, if .env.example exists
}
```

### Install Dependencies

```json
{
  "action": "install",
  "savePath": "/path/to/repo",
  "installCommand": "npm install"
}
```

Runs the installation command in the specified repository.

#### Response

```json
{
  "success": true,
  "path": "/path/to/repo",
  "relativePath": "/path/to/repo",
  "installCommand": "npm install",
  "commandOutput": "Output from the install command"
}
```

### Build Project

```json
{
  "action": "build",
  "savePath": "/path/to/repo",
  "buildCommand": "npm run build"
}
```

Runs the build command in the specified repository.

#### Response

```json
{
  "success": true,
  "path": "/path/to/repo",
  "relativePath": "/path/to/repo",
  "buildCommand": "npm run build",
  "commandOutput": "Output from the build command"
}
```

### Run Command

```json
{
  "action": "run",
  "savePath": "/path/to/repo",
  "runCommand": "npm start",
  "args": ["--port", "3000"], // Optional
  "env": { "NODE_ENV": "development" } // Optional
}
```

Runs a command in the specified repository with optional arguments and environment variables.

#### Response

```json
{
  "success": true,
  "path": "/path/to/repo",
  "relativePath": "/path/to/repo",
  "runCommand": "npm start",
  "commandOutput": "Output from the run command"
}
```

### Read File

```json
{
  "action": "readFile",
  "savePath": "/path/to/repo/file.txt"
}
```

Reads the content of a file in a repository.

#### Response

```json
{
  "success": true,
  "path": "/path/to/repo/file.txt",
  "relativePath": "/path/to/repo/file.txt",
  "content": "File content"
}
```

### List Repositories

```json
{
  "action": "list"
}
```

Lists all repositories in the MCP servers directory.

#### Response

```json
{
  "success": true,
  "repositories": ["repo1", "repo2", "repo3"]
}
```

## Error Handling

The API returns appropriate HTTP status codes and error messages:

- `400 Bad Request`: Missing or invalid parameters
- `500 Internal Server Error`: Server-side errors

Error responses include a descriptive message:

```json
{
  "error": "Error message"
}
```

For command execution errors, additional information is provided:

```json
{
  "error": "Failed to run command: Error message",
  "path": "/path/to/repo",
  "relativePath": "/path/to/repo",
  "runCommand": "npm start",
  "commandOutput": "Error output from the command"
}
```

## Usage Examples

### Clone a Repository

```typescript
const response = await fetch('/api/git', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'clone',
    repoUrl: 'https://github.com/username/repo.git',
    savePath: '/path/to/save/repo',
    branch: 'main'
  })
});

const data = await response.json();
if (data.success) {
  console.log(`Repository cloned to: ${data.path}`);
} else {
  console.error(`Error: ${data.error}`);
}
```

### Run a Command

```typescript
const response = await fetch('/api/git', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'run',
    savePath: '/path/to/repo',
    runCommand: 'npm start',
    args: ['--port', '3000'],
    env: { 'NODE_ENV': 'development' }
  })
});

const data = await response.json();
if (data.success) {
  console.log(`Command output: ${data.commandOutput}`);
} else {
  console.error(`Error: ${data.error}`);
}
```

## Security Considerations

### Command Execution

The API executes commands on the server, which could potentially be a security risk if not properly validated. The implementation includes several safeguards:

1. **Path Validation**: Ensures commands are only executed in the intended directories
2. **Command Sanitization**: Properly handles command arguments to prevent injection
3. **Error Handling**: Captures and logs errors without exposing sensitive information

### Repository Management

The API manages Git repositories, which requires careful handling:

1. **Repository Isolation**: Repositories are stored in a dedicated directory
2. **Shallow Clones**: Uses `--depth 1` for efficient and faster cloning
3. **Branch Specification**: Allows cloning specific branches for better control
