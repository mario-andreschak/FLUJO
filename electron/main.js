const { app, BrowserWindow, Menu, Tray, ipcMain } = require('electron');
const path = require('path');
const isDev = require('electron-is-dev');
const { spawn } = require('child_process');
const fs = require('fs');

// Hide the default menu
Menu.setApplicationMenu(null);

// Keep a global reference of the window object to avoid garbage collection
let mainWindow;
let tray;
let nextProcess;
let isQuitting = false;

// Default port for Next.js server
const PORT = 4200;

// Create the browser window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
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

  // Open DevTools only if NODE_ENV is explicitly set to 'development'
  if (process.env.NODE_ENV === 'development') {
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
}

// Start the Next.js server
function startNextServer() {
  return new Promise((resolve, reject) => {
    console.log('Starting Next.js server...');

    // Start the Next.js server
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
    let startupTimeout = setTimeout(() => {
      reject(new Error('Timeout waiting for Next.js server to start'));
    }, 30000);

    // Simple polling to check if the server is up
    const checkServer = () => {
      const http = require('http');
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
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

// App ready event
app.whenReady().then(async () => {
  try {
    await startNextServer();
    createWindow();
    createTray();
  } catch (error) {
    console.error('Failed to start application:', error);
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
    nextProcess.kill();
  }
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
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
