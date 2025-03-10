# FLUJO Electron Integration

This directory contains the Electron integration for FLUJO, allowing it to run as a desktop application while maintaining the ability to run as a web application.

## Features

- **Desktop Application**: Run FLUJO as a native desktop application
- **System Tray Integration**: Minimize to system tray for quick access
- **Network Mode**: Configure the application to be accessible from other devices on the network
- **Dual-Mode Operation**: Run as a desktop app or as a web server accessible from any browser

## Development

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn

### Running in Development Mode

To run the application in development mode:

```bash
npm run electron-dev
```

This will start the Next.js development server and launch Electron pointing to it.

### Building for Production

To build the application for production:

```bash
npm run electron-dist
```

This will build the Next.js application and package it with Electron for your current platform.

To build for all platforms (Windows, macOS, Linux):

```bash
npm run electron-dist-all
```

Note: Building for platforms other than your current one may require additional setup.

## Architecture

The Electron integration follows a dual-mode architecture:

1. **Desktop Mode**: The application runs as a desktop application with the Next.js frontend displayed in an Electron window.

2. **Network Mode**: The application can be configured to bind to all network interfaces, making it accessible from other devices on the network.

### Key Components

- **electron/main.js**: The main Electron process
- **electron/preload.js**: Preload script for secure context bridge
- **server.js**: Custom Next.js server with network binding configuration
- **src/utils/shared/isElectron.ts**: Utility functions for detecting and interacting with Electron

## Configuration

### Network Mode

Network mode can be configured in two ways:

1. **Through the UI**: In the Settings > Desktop Application section, toggle the "Enable network access" switch.

2. **Environment Variable**: Set the `FLUJO_NETWORK_MODE` environment variable to `1` or `true`.

When network mode is enabled, the application will bind to all network interfaces (0.0.0.0) instead of just localhost, making it accessible from other devices on the network.

## Security Considerations

When running in network mode, the application is accessible from other devices on your network. This can be a security risk if your network is not secure. Consider the following:

- Only enable network mode when needed
- Use a firewall to restrict access to the application
- Consider implementing authentication for remote access

## Troubleshooting

### Application doesn't start

- Check if the port 4200 is already in use
- Try running `npm run dev` to see if the Next.js server starts correctly
- Check the logs in the console for any errors

### Cannot access from other devices

- Make sure network mode is enabled
- Check your firewall settings
- Verify that you're using the correct IP address and port
