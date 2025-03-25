const { exec } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");

// Port for the Next.js server (should match the one in electron/main.js)
const PORT = parseInt(process.env.PORT || "4200", 10);

// URLs for documentation
const SWAGGER_URL = `http://localhost:${PORT}/docs/swagger`;
const STANDARD_DOCS_URL = `http://localhost:${PORT}/docs`;
const OPENAPI_URL = `http://localhost:${PORT}/api/docs`;

/**
 * Open a URL in the default browser
 * @param {string} url - The URL to open
 */
function openUrl(url) {
  console.log(`Opening ${url} in your default browser...`);

  // Different commands based on operating system
  let command;

  switch (process.platform) {
    case "darwin": // macOS
      command = `open "${url}"`;
      break;
    case "win32": // Windows
      command = `start "" "${url}"`;
      break;
    default: // Linux and others
      command = `xdg-open "${url}"`;
      break;
  }

  exec(command, (error) => {
    if (error) {
      console.error(`Failed to open browser: ${error.message}`);
      console.log(`Please manually navigate to: ${url}`);
    }
  });
}

/**
 * Check if a server is running on the given port
 * @param {number} port - The port to check
 * @returns {Promise<boolean>} - True if server is running
 */
function checkServer(port) {
  return new Promise((resolve) => {
    const http = require("http");
    const req = http.get(`http://localhost:${port}`, (res) => {
      resolve(true);
    });

    req.on("error", () => {
      resolve(false);
    });

    // Set a timeout to avoid hanging
    req.setTimeout(3000, () => {
      req.abort();
      resolve(false);
    });
  });
}

async function main() {
  // Determine which URL to open based on command line args
  const args = process.argv.slice(2);
  let url = SWAGGER_URL; // Default to Swagger UI

  if (args.includes("--standard") || args.includes("-s")) {
    url = STANDARD_DOCS_URL;
  } else if (args.includes("--api") || args.includes("-a")) {
    url = OPENAPI_URL;
  }

  // Check if the server is running
  const serverRunning = await checkServer(PORT);

  if (!serverRunning) {
    console.log(`\nERROR: No server detected on port ${PORT}.`);
    console.log(
      `Please start the FLUJO server first with:\n\n  npm run headless-docs\n`
    );
    process.exit(1);
  }

  // Open the URL in the browser
  openUrl(url);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
