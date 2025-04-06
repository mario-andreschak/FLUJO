#!/usr/bin/env node

/**
 * This script prepares the package.json for Docker builds by:
 * 1. Removing Electron-related dependencies
 * 2. Removing Electron-related scripts
 * 3. Modifying the postinstall script to be environment-aware
 */

const fs = require('fs');
const path = require('path');

// Read the original package.json
const packageJsonPath = path.join(process.cwd(), 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

// Create a Docker-specific version
const dockerPackageJson = { ...packageJson };

// Remove Electron-related scripts but keep postinstall
const scriptsToKeep = ['dev', 'build', 'start', 'lint', 'postinstall'];
dockerPackageJson.scripts = Object.entries(packageJson.scripts)
  .filter(([key]) => scriptsToKeep.includes(key))
  .reduce((obj, [key, value]) => {
    obj[key] = value;
    return obj;
  }, {});

// The conditional postinstall script will automatically detect Docker and skip electron-builder

// Remove Electron-related dependencies
const devDepsToRemove = ['electron', 'electron-builder', 'wait-on', 'concurrently'];
if (dockerPackageJson.devDependencies) {
  devDepsToRemove.forEach(dep => {
    if (dockerPackageJson.devDependencies[dep]) {
      delete dockerPackageJson.devDependencies[dep];
    }
  });
}

// Remove electron-is-dev from dependencies
if (dockerPackageJson.dependencies && dockerPackageJson.dependencies['electron-is-dev']) {
  delete dockerPackageJson.dependencies['electron-is-dev'];
}

// Set main to server.js instead of electron/main.js
dockerPackageJson.main = 'server.js';

// Add Docker-specific metadata
dockerPackageJson.name = `${packageJson.name}-docker`;
dockerPackageJson.description = `${packageJson.description || 'Flujo'} (Docker version)`;

// Write the Docker-specific package.json
const outputPath = process.argv[2] || path.join(process.cwd(), 'package.docker.json');
fs.writeFileSync(outputPath, JSON.stringify(dockerPackageJson, null, 2));

console.log(`Docker-specific package.json written to ${outputPath}`);
