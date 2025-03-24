const { app, BrowserWindow, Menu, Tray, ipcMain } = require('electron');
const path = require('path');
const isDev = require('electron-is-dev');
const { spawn } = require('child_process');
const fs = require('fs');
const minimist = require('minimist');
const os = require('os');
const http = require('http');

// Parse command line arguments
const argv = minimist(process.argv.slice(isDev ? 2 : 1));
const headless = argv.headless || argv.h || false;

// Hide the default menu
Menu.setApplicationMenu(null);

// Keep a global reference of the window object to avoid garbage collection
let mainWindow;
let tray;
let nextProcess;
let isQuitting = false;

// Port for the Next.js server
const PORT = parseInt(process.env.PORT || '4200', 10);

// Create the browser window
function createWindow() {
  if (headless) {
    console.log('Running in headless mode - no window will be created');
    return null;
  }
  
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, '../public/favicon.ico'),
  });

  // Load the app
  const startUrl = isDev
    ? `http://localhost:${PORT}`
    : `http://localhost:${PORT}`;

  mainWindow.loadURL(startUrl);

  // Open DevTools in development mode
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // Handle window close event
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  // Handle window closed event
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

// Start the Next.js server
function startNextServer() {
  return new Promise((resolve, reject) => {
    // In development, we assume the Next.js server is already running
    if (isDev) {
      console.log('Development mode: Using existing Next.js server');
      resolve();
      return;
    }

    console.log('Starting Next.js server...');
    
    // In production, we need to start the Next.js server
    nextProcess = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      stdio: 'pipe',
    });

    // Log Next.js server output
    nextProcess.stdout.on('data', (data) => {
      console.log(`Next.js: ${data}`);
    });

    nextProcess.stderr.on('data', (data) => {
      console.error(`Next.js error: ${data}`);
    });

    // Check if server started successfully
    nextProcess.on('error', (error) => {
      console.error(`Failed to start Next.js server: ${error}`);
      reject(error);
    });

    // Wait for the server to start
    const startupTimeout = setTimeout(() => {
      reject(new Error('Timeout waiting for Next.js server to start'));
    }, 30000);

    // Simple polling to check if the server is up
    const checkServer = () => {
      const req = http.get(`http://localhost:${PORT}`, (res) => {
        clearTimeout(startupTimeout);
        console.log('Next.js server started successfully');
        resolve();
      });
      
      req.on('error', (err) => {
        setTimeout(checkServer, 1000);
      });
    };

    setTimeout(checkServer, 1000);
  });
}

// Display network interfaces for headless mode
function displayNetworkInfo() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  
  console.log('\n=======================================================');
  console.log('🚀 FLUJO API SERVER READY!');
  console.log('=======================================================');
  console.log('📡 API Endpoints:');
  console.log(`   - OpenAI API Compatible: http://localhost:${PORT}/v1`);
  console.log(`   - Local API: http://localhost:${PORT}/api`);
  
  // Display all network interfaces that could be accessed from other machines
  console.log('\n📱 Available Network Interfaces:');
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal/non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`   - ${name}: http://${iface.address}:${PORT}/v1`);
        addresses.push(iface.address);
      }
    }
  }
  
  console.log('\n🔍 Example API Calls:');
  console.log('   curl -X POST http://localhost:4200/v1/chat/completions \\');
  console.log('     -H "Content-Type: application/json" \\');
  console.log('     -d \'{"model": "flow-YourFlowName", "messages": [{"role": "user", "content": "Hello"}]}\'');
  
  console.log('\n👋 Press Ctrl+C to exit the application');
  console.log('=======================================================\n');
  
  return addresses;
}

// Create a status endpoint to check if the server is running
function createStatusEndpoint() {
  const startTime = new Date();
  
  const server = http.createServer((req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'running',
        mode: 'headless',
        uptime: Math.floor((new Date() - startTime) / 1000),
        nextjs_port: PORT
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  
  // Use a different port for the status endpoint
  const statusPort = PORT + 1;
  server.listen(statusPort);
  console.log(`Status endpoint available at: http://localhost:${statusPort}/status`);
  
  return server;
}

// Create system tray
function createTray() {
  tray = new Tray(path.join(__dirname, '../public/favicon.ico'));
  
  const contextMenu = Menu.buildFromTemplate([
    { 
      label: 'Open FLUJO', 
      click: () => {
        if (mainWindow === null) {
          createWindow();
        } else {
          mainWindow.show();
        }
      } 
    },
    { 
      label: 'Quit', 
      click: () => {
        isQuitting = true;
        app.quit();
      } 
    },
  ]);
  
  tray.setToolTip('FLUJO');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    if (mainWindow === null) {
      createWindow();
    } else {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
      }
    }
  });
}

// App ready event
app.whenReady().then(async () => {
  try {
    // Always start the Next.js server
    await startNextServer();
    
    // Create window only if not in headless mode
    if (!headless) {
      mainWindow = createWindow();
    } else {
      // Additional setup for headless mode
      const addresses = displayNetworkInfo();
      
      // Create a simple status endpoint
      const statusServer = createStatusEndpoint();
      
      // Write the API info to a file for easier scripting
      const apiInfoFile = path.join(app.getPath('userData'), 'api-info.json');
      fs.writeFileSync(apiInfoFile, JSON.stringify({
        port: PORT,
        addresses: addresses,
        startTime: new Date().toISOString()
      }));
      
      console.log(`API info written to: ${apiInfoFile}`);
      
      // Cleanup on exit
      app.on('will-quit', () => {
        if (statusServer) statusServer.close();
      });
      
      // If a timeout was specified
      if (argv.timeout) {
        const timeoutMinutes = parseInt(argv.timeout, 10);
        if (!isNaN(timeoutMinutes) && timeoutMinutes > 0) {
          console.log(`⏱️ Server will automatically shut down after ${timeoutMinutes} minutes`);
          setTimeout(() => {
            console.log(`\n⏱️ Timeout of ${timeoutMinutes} minutes reached. Shutting down...`);
            app.quit();
          }, timeoutMinutes * 60 * 1000);
        }
      }
    }
    
    createTray();
  } catch (error) {
    console.error('Failed to initialize application:', error);
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// App will quit event
app.on('will-quit', () => {
  // Clean up the Next.js server process
  if (nextProcess) {
    console.log('Shutting down Next.js server...');
    nextProcess.kill();
  }
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !headless) {
    app.quit();
  }
});

// Handle the quit event
app.on('before-quit', () => {
  isQuitting = true;
});

// IPC handlers for communication between renderer and main process
ipcMain.handle('get-app-path', () => {
  return app.getAppPath();
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// Handle network mode configuration
ipcMain.handle('set-network-mode', (event, enabled) => {
  // This would update a configuration file or environment variable
  // to control whether the server binds to localhost or network interfaces
  console.log(`Setting network mode: ${enabled}`);
  
  // Example implementation - in a real app, you'd persist this setting
  const configPath = path.join(app.getPath('userData'), 'config.json');
  let config = {};
  
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (error) {
    console.error('Error reading config:', error);
  }
  
  config.networkMode = enabled;
  
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return { success: true };
  } catch (error) {
    console.error('Error writing config:', error);
    return { success: false, error: error.message };
  }
});

// Add IPC handlers for headless mode control
ipcMain.handle('headless-control', async (event, action, params) => {
  if (action === 'status') {
    return { 
      running: true,
      headless,
      port: PORT,
      startTime: app.startTime || new Date().toISOString()
    };
  }
  
  if (action === 'shutdown') {
    console.log('Received shutdown command');
    setTimeout(() => app.quit(), 500);
    return { success: true };
  }
  
  return { success: false, error: 'Unknown action' };
});
