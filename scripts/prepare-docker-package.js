#!/usr/bin/env node

/**
 * This script prepares the package.json for Docker builds
 */

const fs = require('fs');
const path = require('path');

// Read the original package.json
const packageJsonPath = path.join(process.cwd(), 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

// Create a Docker-specific version
const dockerPackageJson = { ...packageJson };

// Keep all scripts except any that might be added in the future
dockerPackageJson.scripts = { ...packageJson.scripts };

// Set main to server.js
dockerPackageJson.main = 'server.js';

// Add Docker-specific metadata
dockerPackageJson.name = `${packageJson.name}-docker`;
dockerPackageJson.description = `${packageJson.description || 'Flujo'} (Docker version)`;

// Write the Docker-specific package.json
const outputPath = process.argv[2] || path.join(process.cwd(), 'package.docker.json');
fs.writeFileSync(outputPath, JSON.stringify(dockerPackageJson, null, 2));

console.log(`Docker-specific package.json written to ${outputPath}`);
