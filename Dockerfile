FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy Chart.js UMD bundle to public/vendor
RUN mkdir -p public/vendor && \
    cp node_modules/chart.js/dist/chart.umd.js public/vendor/chart.umd.min.js

COPY --chown=node:node server.js ./
COPY --chown=node:node config/ ./config/
COPY --chown=node:node public/ ./public/

EXPOSE 3000

USER node

CMD ["node", "server.js"]
