#!/bin/bash
set -e

# This script runs the Flujo Docker container with appropriate volume mounts
# and port mappings.

# Parse command line arguments
TAG="latest"
DETACHED=false
PRIVILEGED=true
PORT=4200

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --tag=*) TAG="${1#*=}" ;;
        --detached) DETACHED=true ;;
        --no-privileged) PRIVILEGED=false ;;
        --port=*) PORT="${1#*=}" ;;
        *) echo "Unknown parameter: $1"; exit 1 ;;
    esac
    shift
done

# Setup colored output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color
INFO_MARK="ℹ"

# Create data directory if it doesn't exist
DATA_DIR="$HOME/.flujo"
mkdir -p "$DATA_DIR"
echo -e "${GREEN}${INFO_MARK} Using data directory: $DATA_DIR${NC}"

# Build the Docker run command
DOCKER_CMD="docker run"

# Add detached mode if requested
if [ "$DETACHED" = true ]; then
    DOCKER_CMD="$DOCKER_CMD -d"
    echo -e "${GREEN}${INFO_MARK} Running in detached mode${NC}"
else
    DOCKER_CMD="$DOCKER_CMD -it"
fi

# Add privileged mode if requested
if [ "$PRIVILEGED" = true ]; then
    DOCKER_CMD="$DOCKER_CMD --privileged"
    echo -e "${YELLOW}${INFO_MARK} Running in privileged mode (required for Docker-in-Docker)${NC}"
fi

# Add port mapping
DOCKER_CMD="$DOCKER_CMD -p $PORT:4200"
echo -e "${GREEN}${INFO_MARK} Mapping port $PORT to container port 4200${NC}"

# Add volume mounts
DOCKER_CMD="$DOCKER_CMD -v $DATA_DIR:/app/data"
echo -e "${GREEN}${INFO_MARK} Mounting $DATA_DIR to /app/data${NC}"

# Add container name
DOCKER_CMD="$DOCKER_CMD --name flujo"

# Add image name and tag
DOCKER_CMD="$DOCKER_CMD flujo:$TAG"

# Run the container
echo -e "${GREEN}${INFO_MARK} Starting Flujo container...${NC}"
echo "Command: $DOCKER_CMD"
eval $DOCKER_CMD

# If running in detached mode, show how to view logs
if [ "$DETACHED" = true ]; then
    echo -e "\n${GREEN}Container started in detached mode.${NC}"
    echo "To view logs: docker logs -f flujo"
    echo "To stop container: docker stop flujo"
fi
