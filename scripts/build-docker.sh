#!/bin/bash
set -e

# Force immediate output
exec 1>&1

# This script provides a lightweight Docker build pipeline
# that stores logs rather than printing them directly.

# Parse command line arguments
VERBOSE=false
TAG="latest"
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --verbose) VERBOSE=true ;;
        --tag=*) TAG="${1#*=}" ;;
        *) echo "Unknown parameter: $1"; exit 1 ;;
    esac
    shift
done

# Create temp directory for logs if it doesn't exist
TEMP_DIR="/tmp/flujo-docker"
mkdir -p "$TEMP_DIR"

# Setup colored output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color
CHECK_MARK="✓"
X_MARK="✗"
WARNING_MARK="⚠"

# Function to check log file size and show warning if needed
check_log_size() {
    local log_file=$1
    if [ -f "$log_file" ]; then
        local line_count=$(wc -l < "$log_file")
        if [ $line_count -gt 100 ]; then
            echo -e "${YELLOW}${WARNING_MARK} Large log file detected ($line_count lines)${NC}"
            echo "  Tips for viewing large logs:"
            echo "  • head -n 20 $log_file     (view first 20 lines)"
            echo "  • tail -n 20 $log_file     (view last 20 lines)"
            echo "  • less $log_file           (scroll through file)"
            echo "  • grep 'error' $log_file   (search for specific terms)"
        fi
    fi
}

# Build Docker image
echo "→ Preparing Docker-specific package.json..."
echo "→ Building Docker image (tag: flujo:$TAG)..."
if [ "$VERBOSE" = true ]; then
    if docker build -t flujo:$TAG .; then
        echo -e "${GREEN}${CHECK_MARK} Docker build successful${NC}"
    else
        echo -e "${RED}${X_MARK} Docker build failed${NC}"
        exit 1
    fi
else
    DOCKER_LOG="$TEMP_DIR/docker-build.log"
    if docker build -t flujo:$TAG . > "$DOCKER_LOG" 2>&1; then
        echo -e "${GREEN}${CHECK_MARK} Docker build successful${NC} (log: $DOCKER_LOG)"
        check_log_size "$DOCKER_LOG"
    else
        echo -e "${RED}${X_MARK} Docker build failed${NC} (see details in $DOCKER_LOG)"
        check_log_size "$DOCKER_LOG"
        exit 1
    fi
fi

echo -e "\n${GREEN}Build complete!${NC} Image tagged as flujo:$TAG"
