# LiveLyrics: single container serving the API and the built client.
# Build:  docker build -t livelyrics .
# Run:    docker run --rm -p 8080:8080 livelyrics            (mock mode, no keys)

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY client client
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8080 \
    PROVIDER_MODE=mock \
    STATIC_DIR=/app/client/dist
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/package.json shared/
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
USER node
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
