FROM node:18-alpine

# Install necessary system dependencies
RUN apk add --no-cache python3 make g++ curl

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm ci --only=production

# Bundle app source
COPY . .

# Create necessary directories with proper permissions
RUN mkdir -p /app/logs /app/data && \
    chown -R node:node /app

# Switch to non-root user
USER node

# Set production environment
ENV NODE_ENV=production

# Expose port
EXPOSE 3000

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD npm run healthcheck

# Start the application
CMD [ "npm", "start" ]