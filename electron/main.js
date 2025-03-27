const { app, BrowserWindow, Menu, Tray, ipcMain } = require("electron");
const path = require("path");
const isDev = require("electron-is-dev");
const { spawn } = require("child_process");
const fs = require("fs");
const minimist = require("minimist");
const os = require("os");
const http = require("http");
const projectRoot = path.resolve(__dirname, "..");

// Parse command line arguments
const argv = minimist(process.argv.slice(isDev ? 2 : 1));
const headless = argv.headless || argv.h || false;
const showDocs = argv.docs || false; // New flag for docs

// Global startup timeout (2 minutes)
const GLOBAL_STARTUP_TIMEOUT = 120000;

// Hide the default menu
Menu.setApplicationMenu(null);

// Keep a global reference of the window object to avoid garbage collection
let mainWindow;
let tray;
let nextProcess;
let isQuitting = false;

// Port for the Next.js server
const PORT = parseInt(process.env.PORT || "4200", 10);

// Create the browser window
function createWindow() {
  if (headless) {
    console.log("Running in headless mode - no window will be created");
    return null;
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    icon: path.join(__dirname, "../public/favicon.ico"),
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
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  // Handle window closed event
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

// Start the Next.js server
function startNextServer() {
  return new Promise((resolve, reject) => {
    console.log("Starting Next.js server...");

    // Command and arguments based on development mode
    const command = isDev ? "npm" : "node";
    const args = isDev ? ["run", "dev"] : ["server.js"];

    // Set environment variables
    const env = {
      ...process.env,
      PORT: PORT.toString(),
      NEXT_PUBLIC_DOCS_ENABLED: showDocs ? "true" : "false",
      NEXT_PUBLIC_HEADLESS: headless ? "true" : "false",
    };

    // Kill any existing process before starting new one
    if (nextProcess) {
      try {
        nextProcess.kill();
      } catch (err) {
        console.error("Error terminating existing process:", err);
      }
    }

    nextProcess = spawn(command, args, {
      cwd: path.join(__dirname, ".."),
      stdio: "pipe",
      shell: true,
      env: env,
    });

    // Log Next.js server output
    nextProcess.stdout.on("data", (data) => {
      const output = data.toString().trim();
      if (output) console.log(`Next.js: ${output}`);
    });

    nextProcess.stderr.on("data", (data) => {
      const error = data.toString().trim();
      if (error) console.error(`Next.js error: ${error}`);
    });

    // Check if server started successfully
    nextProcess.on("error", (error) => {
      console.error(`Failed to start Next.js server: ${error}`);
      reject(error);
    });

    // Don't wait for the server to actually start in development mode unless we have the docs flag
    if (isDev && !showDocs && !headless) {
      console.log(
        "Development mode: Assuming Next.js server will start shortly"
      );
      setTimeout(resolve, 1000);
      return;
    }

    // Create a simpler polling mechanism
    let attempts = 0;
    const maxAttempts = 30;
    const checkInterval = 2000;
    let intervalId = null; // Define intervalId in this scope

    const checkServer = () => {
      attempts++;

      const req = http.get(`http://localhost:${PORT}`, (res) => {
        console.log(`Server is up! Status code: ${res.statusCode}`);
        if (intervalId) clearInterval(intervalId);
        resolve();
      });

      req.on("error", (err) => {
        if (attempts >= maxAttempts) {
          console.error(
            "Maximum attempts reached. Server might not be starting properly."
          );
          if (intervalId) clearInterval(intervalId);
          resolve(); // Resolve anyway to allow the app to continue
        }
      });

      // Set a short timeout for each request
      req.setTimeout(1500, () => {
        req.abort();
      });
    };

    // Start checking after a delay
    setTimeout(() => {
      checkServer();
      intervalId = setInterval(() => {
        if (attempts < maxAttempts) {
          checkServer();
        } else {
          clearInterval(intervalId);
        }
      }, checkInterval);
    }, 5000);
  });
}

// Display network interfaces for headless mode
function displayNetworkInfo() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  console.log("\n=======================================================");
  console.log("FLUJO API SERVER READY!");
  console.log("=======================================================");
  console.log("API Endpoints:");
  console.log(`   - OpenAI API Compatible: http://localhost:${PORT}/v1`);
  console.log(`   - Local API: http://localhost:${PORT}/api`);

  // Display all network interfaces that could be accessed from other machines
  console.log("\nAvailable Network Interfaces:");
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal/non-IPv4 addresses
      if (iface.family === "IPv4" && !iface.internal) {
        console.log(`   - ${name}: http://${iface.address}:${PORT}/api`);
        addresses.push(iface.address);
      }
    }
  }

  if (showDocs) {
    console.log("\nAPI Documentation:");
    console.log(`   Swagger UI: http://localhost:${PORT}/docs/swagger`);
    console.log(`   OpenAPI JSON: http://localhost:${PORT}/api/docs`);
  } else {
    console.log("\nTo view API documentation:");
    console.log("   Run with: npm run headless-docs");
  }

  console.log("\nStatus endpoint:");
  console.log(`   http://localhost:${PORT + 1}/status`);

  console.log("\nPress Ctrl+C to exit the application");
  console.log("=======================================================\n");

  return addresses;
}

// Create a status endpoint to check if the server is running
function createStatusEndpoint() {
  const startTime = new Date();

  const server = http.createServer((req, res) => {
    // Enable CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    // Handle OPTIONS preflight requests
    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    // Handle GET requests to /status
    if (req.url === "/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "running",
          mode: headless ? "headless" : "gui",
          uptime: Math.floor((new Date() - startTime) / 1000),
          nextjs_port: PORT,
          api_docs: showDocs,
          version: app.getVersion(),
          docs_url: showDocs ? `http://localhost:${PORT}/docs/swagger` : null,
        })
      );
      return;
    }

    // Handle POST requests to /shutdown
    if (req.url === "/shutdown" && req.method === "POST") {
      let body = "";

      req.on("data", (chunk) => {
        body += chunk.toString();
      });

      req.on("end", () => {
        let requestData;
        try {
          requestData = JSON.parse(body);
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Invalid JSON" }));
          return;
        }

        // Check for shutdown action
        if (requestData.action === "shutdown") {
          console.log("Received shutdown command via API");

          // Send success response before shutting down
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              message: "Server is shutting down",
            })
          );

          // Give time for the response to be sent before shutting down
          setTimeout(() => {
            console.log("Shutting down application...");
            app.quit();
          }, 500);
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: false,
              error: "Invalid action",
            })
          );
        }
      });

      return;
    }

    // Handle all other requests
    res.writeHead(404);
    res.end();
  });

  // Use a different port for the status endpoint
  const statusPort = PORT + 1;
  server.listen(statusPort);

  console.log(
    `Status endpoint available at: http://localhost:${statusPort}/status`
  );

  return server;
}

// Create system tray
function createTray() {
  // Only create tray if it doesn't already exist
  if (tray) return;

  try {
    tray = new Tray(path.join(__dirname, "../public/favicon.ico"));

    const contextMenu = Menu.buildFromTemplate([
      {
        label: headless ? "FLUJO (Headless Mode)" : "Open FLUJO",
        enabled: !headless,
        click: () => {
          if (mainWindow === null) {
            createWindow();
          } else {
            mainWindow.show();
          }
        },
      },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);

    tray.setToolTip(headless ? "FLUJO (Headless Mode)" : "FLUJO");
    tray.setContextMenu(contextMenu);

    // Only add click handler for desktop mode
    if (!headless) {
      tray.on("click", () => {
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
  } catch (error) {
    console.error("Failed to create system tray:", error);
  }
}

// App ready event
app.whenReady().then(async () => {
  try {
    // Set global startup timeout
    let startupTimeoutId = setTimeout(() => {
      console.log("Global startup timeout reached. Force quitting...");
      app.exit(1);
    }, GLOBAL_STARTUP_TIMEOUT);

    // Always start the Next.js server
    await startNextServer();

    // Create window only if not in headless mode
    if (!headless) {
      mainWindow = createWindow();
    } else {
      // Additional setup for headless mode
      const addresses = displayNetworkInfo();
      createStatusEndpoint();
    }

    // Create system tray
    createTray();

    // Clear the global startup timeout once everything is initialized
    clearTimeout(startupTimeoutId);
  } catch (error) {
    console.error("Failed to initialize application:", error);
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// App will quit event
app.on("will-quit", () => {
  // Clean up the Next.js server process
  if (nextProcess) {
    console.log("Shutting down Next.js server...");
    nextProcess.kill();
  }

  // Clean up tray
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

// Quit when all windows are closed, except on macOS
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !headless) {
    app.quit();
  }
});

// Handle the quit event
app.on("before-quit", () => {
  isQuitting = true;
});

// IPC handlers for communication between renderer and main process
ipcMain.handle("get-app-path", () => {
  return app.getAppPath();
});

ipcMain.handle("get-app-version", () => {
  return app.getVersion();
});

// Handle network mode configuration
ipcMain.handle("set-network-mode", (event, enabled) => {
  // This would update a configuration file or environment variable
  // to control whether the server binds to localhost or network interfaces
  console.log(`Setting network mode: ${enabled}`);

  // Example implementation - in a real app, you'd persist this setting
  const configPath = path.join(app.getPath("userData"), "config.json");
  let config = {};

  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  } catch (error) {
    console.error("Error reading config:", error);
  }

  config.networkMode = enabled;

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return { success: true };
  } catch (error) {
    console.error("Error writing config:", error);
    return { success: false, error: error.message };
  }
});

// Add IPC handlers for headless mode control
ipcMain.handle("headless-control", async (event, action, params) => {
  if (action === "status") {
    return {
      running: true,
      headless,
      port: PORT,
      startTime: app.startTime || new Date().toISOString(),
    };
  }

  if (action === "shutdown") {
    console.log("Received shutdown command");
    setTimeout(() => app.quit(), 500);
    return { success: true };
  }

  return { success: false, error: "Unknown action" };
});
