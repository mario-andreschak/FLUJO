const http = require("http");

// Port for the status endpoint (should match the one in electron/main.js)
const STATUS_PORT = 4201;

/**
 * Send a shutdown command to the headless server
 */
async function shutdownServer() {
  return new Promise((resolve, reject) => {
    console.log("Sending shutdown command to FLUJO headless server...");

    const options = {
      hostname: "localhost",
      port: STATUS_PORT,
      path: "/shutdown",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    };

    const req = http.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        if (res.statusCode === 200) {
          console.log("✅ Shutdown command sent successfully.");
          console.log("Server is shutting down...");
          resolve(true);
        } else {
          console.error(
            `❌ Error: Server returned status code ${res.statusCode}`
          );
          console.error(data);
          resolve(false);
        }
      });
    });

    req.on("error", (error) => {
      console.error(`❌ Error connecting to server: ${error.message}`);
      console.log("Make sure the FLUJO headless server is running.");
      resolve(false);
    });

    // Set a timeout
    req.setTimeout(5000, () => {
      req.destroy();
      console.error("❌ Request timed out. Server may be unresponsive.");
      resolve(false);
    });

    req.write(JSON.stringify({ action: "shutdown" }));
    req.end();
  });
}

// Check server status first
async function checkServerStatus() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${STATUS_PORT}/status`, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            const status = JSON.parse(data);
            console.log("✅ FLUJO headless server is running.");
            console.log(
              `Mode: ${status.mode}, Uptime: ${status.uptime} seconds`
            );
            resolve(true);
          } catch (e) {
            console.log(
              "✅ FLUJO headless server is running, but returned invalid status data."
            );
            resolve(true);
          }
        } else {
          console.error(`❌ Server returned status code ${res.statusCode}`);
          resolve(false);
        }
      });
    });

    req.on("error", () => {
      console.error("❌ No FLUJO headless server detected.");
      resolve(false);
    });

    req.setTimeout(3000, () => {
      req.destroy();
      console.error("❌ Status request timed out. Server may be unresponsive.");
      resolve(false);
    });
  });
}

async function main() {
  const serverRunning = await checkServerStatus();

  if (!serverRunning) {
    process.exit(1);
  }

  const success = await shutdownServer();
  process.exit(success ? 0 : 1);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
