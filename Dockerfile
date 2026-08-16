# Playwright needs system libs nixpacks does not ship (libglib, etc.).
# Keep image tag in sync with package.json "playwright" version (exact).
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DISPLAY=:99

# Xvfb: Booking.com Connect must be headed. HeadlessChrome is blocked on Next.
RUN apt-get update && apt-get install -y --no-install-recommends xvfb \
 && rm -rf /var/lib/apt/lists/*

# package-lock.json is gitignored in this repo — install from package.json.
COPY package.json ./
RUN npm install --omit=dev \
 && npx playwright install chrome || true

COPY . .
RUN chmod +x scripts/docker-start.sh

EXPOSE 3000
CMD ["./scripts/docker-start.sh"]
