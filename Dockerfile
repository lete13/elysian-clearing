# Playwright needs system libs nixpacks does not ship (libglib, etc.).
# Keep image tag in sync with package.json "playwright" version (exact).
# Boot: srv-boot.js applies srv/patches*.json → server.gen.js, then that process
# applies fe/patches*.json to the SPA. Do not change CMD to plain server.js.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# package-lock.json is gitignored in this repo — install from package.json.
COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "srv-boot.js"]
