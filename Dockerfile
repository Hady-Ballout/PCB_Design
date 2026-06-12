FROM node:20-slim

# Install Ngspice
RUN apt-get update && \
    apt-get install -y ngspice --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy server source
COPY server/ ./server/
COPY src/lib/pcbGenerator.js ./src/lib/pcbGenerator.js

ENV NODE_ENV=production
ENV HOST=0.0.0.0

EXPOSE 8787

CMD ["node", "server/index.js"]
