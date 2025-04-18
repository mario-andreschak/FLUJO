#!/usr/bin/env node

/**
 * This script detects if we're running in a Docker environment.
 * Previously used for Electron-related tasks, now kept for Docker detection.
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

// Check and log Docker environment status
const inDocker = isDocker();
console.log(`Running in Docker environment: ${inDocker ? 'Yes' : 'No'}`);

// This script previously ran Electron-related tasks, which have been removed
