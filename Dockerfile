FROM node:22-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/
COPY config_example.yml ./

# Build the application
RUN npm run build

# Create config directory
RUN mkdir -p /app/config

# Create entrypoint script
COPY docker_entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Set the config directory as a volume
VOLUME /app/config

# Set entrypoint
ENTRYPOINT ["/app/entrypoint.sh"]
