# Stage 1: Prepare stage
FROM node:20-alpine AS prepare

# Set working directory
WORKDIR /app

# Copy package files and scripts
COPY package.json package-lock.json ./
COPY scripts/prepare-docker-package.js scripts/conditional-postinstall.js ./scripts/

# Generate Docker-specific package.json
RUN node scripts/prepare-docker-package.js ./package.json

# Stage 2: Build stage
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy Docker-specific package.json, lock file, and scripts
COPY --from=prepare /app/package.json ./
COPY --from=prepare /app/scripts ./scripts
COPY package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Stage 3: Runtime stage with Docker-in-Docker support
FROM docker:dind

# Install Node.js and npm
RUN apk add --no-cache nodejs npm

# Set working directory
WORKDIR /app

# Copy Docker-specific package.json and lock file
COPY --from=prepare /app/package.json ./
COPY package-lock.json ./

# Copy built application from builder stage
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.ts ./
COPY --from=builder /app/server.js ./
COPY --from=builder /app/scripts ./scripts

# Install production dependencies only
RUN npm ci --production --omit=dev

# Create directory for MCP servers
RUN mkdir -p /app/mcp-servers

# Create directory for persistent storage
RUN mkdir -p /app/data

# Expose the application port
EXPOSE 4200

# Create entrypoint script
COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Set entrypoint
ENTRYPOINT ["docker-entrypoint.sh"]

# Default command
CMD ["npm", "start"]
