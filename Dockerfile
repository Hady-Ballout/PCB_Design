FROM node:20-slim

# Install Ngspice
RUN apt-get update && \
    apt-get install -y ngspice --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies (incl. devDependencies, needed to compile TypeScript below)
COPY package*.json ./
RUN npm ci

# Copy server source + the src/core modules it imports, then compile TS -> JS
COPY tsconfig.server.json ./
COPY server/ ./server/
COPY src/core/ ./src/core/
RUN npm run build:server

# Drop devDependencies now that the build is done
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV HOST=0.0.0.0

EXPOSE 8787

CMD ["node", "dist/server/server/index.js"]
