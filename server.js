const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const fs = require('fs');
const path = require('path');

// Default port
const port = parseInt(process.env.PORT || '4200', 10);

// Determine if we should bind to all interfaces or just localhost
let networkMode = false;

// Override with environment variable if set
if (process.env.FLUJO_NETWORK_MODE === '1' || process.env.FLUJO_NETWORK_MODE === 'true') {
  networkMode = true;
}

// Host to bind to
const hostname = networkMode ? '0.0.0.0' : 'localhost';

// Prepare the Next.js app
const app = next({
  dev: process.env.NODE_ENV !== 'production',
  hostname,
  port,
});

const handle = app.getRequestHandler();

app.prepare().then(() => {
  createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  }).listen(port, hostname, (err) => {
    if (err) throw err;
    
    const addressInfo = networkMode ? 
      `all interfaces (${hostname}) on port ${port}` : 
      `${hostname}:${port}`;
    
    console.log(`> Ready on ${addressInfo}`);
    
    if (networkMode) {
      // Log the actual IP addresses for network access
      const { networkInterfaces } = require('os');
      const nets = networkInterfaces();
      
      console.log('> Available on:');
      
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          // Skip internal and non-IPv4 addresses
          if (net.family === 'IPv4' && !net.internal) {
            console.log(`>   http://${net.address}:${port}`);
          }
        }
      }
    }
  });
});
