#!/usr/bin/env node

/**
 * This script conditionally runs electron-builder install-app-deps
 * only if we're not in a Docker environment.
 */

// Check if we're in a Docker environment
const isDocker = () => {
  try {
    const fs = require('fs');

    // Method 1: Check for .dockerenv file
    if (fs.existsSync('/.dockerenv')) {
      return true;
    }

    // Method 2: Check for container env var
    if (process.env.container === 'docker') {
      return true;
    }

    // Method 3: Check overlay filesystem in /proc/mounts
    try {
      const mounts = fs.readFileSync('/proc/mounts', 'utf8');
      if (mounts.includes('overlay / overlay')) {
        return true;
      }
    } catch (err) {
      // Ignore if can't read /proc/mounts
    }

    // Method 4: Check cgroup v1 and v2
    try {
      const contents = fs.readFileSync('/proc/self/cgroup', 'utf8');
      return contents.includes('docker') || contents.includes('0::/') || contents.includes('/docker/');
    } catch (err) {
      // Ignore if can't read cgroups
      return false;
    }
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
