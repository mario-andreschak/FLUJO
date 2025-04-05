#!/bin/sh
set -e

# Start the Docker daemon if not already running
if ! docker info > /dev/null 2>&1; then
  echo "Starting Docker daemon..."
  dockerd --host=unix:///var/run/docker.sock &
  
  # Wait for Docker daemon to start
  echo "Waiting for Docker daemon to start..."
  until docker info > /dev/null 2>&1; do
    sleep 1
  done
  echo "Docker daemon started"
fi

# Execute the command passed to the container
exec "$@"
