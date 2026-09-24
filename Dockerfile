# RideSquad — WebSocket relay + static frontend, deployable to any container host
# (Northflank, Render, Railway, Fly.io, a plain VPS, etc.)
FROM node:20-alpine

WORKDIR /app

# Install only the server's own dependency (ws) - keeps the image small and
# avoids pulling in the Capacitor/Android tooling from the root package.json,
# which is irrelevant to running the server.
COPY server/package.json server/package-lock.json* ./server/
RUN npm --prefix server install --omit=dev

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "server/server.js"]
