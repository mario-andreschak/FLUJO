#!/usr/bin/env node

/**
 * This script conditionally runs electron-builder install-app-deps
 * only if we're not in a Docker environment.
 */

// Check if we're in a Docker environment
const isDocker = () => {
  try {
    // Check for .dockerenv file
    const fs = require('fs');
    if (fs.existsSync('/.dockerenv')) {
      return true;
    }

    // Check for Docker in cgroup
    const contents = fs.readFileSync('/proc/self/cgroup', 'utf8');
    return contents.includes('docker');
  } catch (err) {
    return false;
  }
};

// If we're not in Docker, run electron-builder
if (!isDocker()) {
  console.log('Not in Docker environment, running electron-builder install-app-deps');
  const { execSync } = require('child_process');
  try {
    execSync('electron-builder install-app-deps', { stdio: 'inherit' });
  } catch (error) {
    console.error('Failed to run electron-builder:', error.message);
    process.exit(1);
  }
} else {
  console.log('In Docker environment, skipping electron-builder install-app-deps');
}
