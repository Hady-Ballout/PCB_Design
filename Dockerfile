FROM node:20-slim

# Install Ngspice
RUN apt-get update && \
    apt-get install -y ngspice curl ca-certificates --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Install arduino-cli + the AVR toolchain (for /api/compile-sketch)
RUN curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR=/usr/local/bin sh && \
    arduino-cli core update-index && \
    arduino-cli core install arduino:avr && \
    arduino-cli lib install "LiquidCrystal I2C" "Keypad" "Adafruit SSD1306" \
      "Adafruit GFX Library" "Adafruit BusIO" "Servo" \
      "DHT sensor library" "Adafruit Unified Sensor"

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy server source
COPY server/ ./server/
COPY src/core/ ./src/core/
RUN ls -la /app/server/

ENV NODE_ENV=production
ENV HOST=0.0.0.0

EXPOSE 8787

CMD ["node", "server/index.js"]
