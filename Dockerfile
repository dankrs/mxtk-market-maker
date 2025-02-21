FROM node:18-alpine

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Bundle app source
COPY . .

# Create logs directory
RUN mkdir -p /tmp/logs

# Set production environment
ENV NODE_ENV=production

# Expose port
EXPOSE 3000

# Start the application
CMD [ "npm", "start" ] 