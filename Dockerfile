# Digest-pinned multi-platform bases; static assets build on the builder's CPU.
FROM --platform=$BUILDPLATFORM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html favicon.svg vite.config.js ./
COPY src/ ./src/
COPY public/ ./public/
RUN npm run build

FROM nginx:1.30.6-alpine@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951 AS runtime
LABEL org.opencontainers.image.source="https://github.com/oberones/markov-playground-js" \
      org.opencontainers.image.title="Markov Playground"
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist/ /srv/markov-playground-js/
USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/index.html || exit 1
# Immutable configuration: bypass the upstream entrypoint's rewrite scripts.
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
