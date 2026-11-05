# Build on the same Debian release as the runtime so native modules match.
FROM node:24-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# Public RDS certificate bundle, so database TLS can be verified.
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-ca.pem

# Fail the build early if native Argon2 or the TypeScript loader cannot load.
RUN node --import tsx -e "import('argon2').then(() => import('./server/config.ts'))"

FROM gcr.io/distroless/nodejs24-debian13:nonroot
WORKDIR /app
ENV NODE_ENV=production
# The worker filesystem is read-only, so tsx must not write a cache.
ENV TSX_DISABLE_CACHE=1
ENV DATABASE_CA_FILE=/app/certs/rds-ca.pem
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/certs ./certs
USER 65532:65532
EXPOSE 4310
CMD ["--import", "tsx", "server/main.ts"]
