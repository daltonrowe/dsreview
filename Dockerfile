# syntax=docker/dockerfile:1
# Production image. Built by Kamal (bin/kamal deploy) or by hand:
#   docker build -t design-system-review .
#   docker run --rm -p 3000:3000 -e REVIEW_PASS=eezy design-system-review

FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Throw-away stage so the final image carries only production node_modules (express).
# --ignore-scripts: Playwright and its browser download are dev-only (surveys run locally).
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM base
COPY --from=deps /app/node_modules ./node_modules
# Owned by node so the app can read everything regardless of the build machine's file modes.
COPY --chown=node:node . .

# Decisions live on the named volume mounted here (config/deploy.yml). Owned by node so it is
# writable; Docker copies this ownership into a new empty volume on first mount.
RUN mkdir -p /app/data && chown node:node /app/data

ENV HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data

USER node
EXPOSE 3000
CMD ["node", "tools/server.mjs"]
