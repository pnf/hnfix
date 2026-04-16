# Use official Playwright image — has Chromium pre-installed and all system deps
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# Copy package files and install prod deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy app source
COPY server.js ./
COPY public/ ./public/

# Playwright in this image puts browsers at /ms-playwright
# Tell the app where to find Chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Create pdfs dir
RUN mkdir -p pdfs

EXPOSE 8080
ENV PORT=8080

CMD ["node", "server.js"]
