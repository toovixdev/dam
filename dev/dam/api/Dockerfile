# ── Stage 1: build the static agent binary (served at /api/download for installs) ──
# Build context is ./dam (see docker-compose), so both api/ and agent/ are available.
FROM golang:1.22-alpine AS agent
WORKDIR /src
COPY agent/go.mod ./
COPY agent/*.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /out/dam-agent-linux-amd64 .

# ── Stage 2: the control-plane API ──
FROM node:20-alpine
WORKDIR /app
COPY api/package.json ./
RUN npm install --production
COPY api/main.js api/archive.js ./
# The customer-installable agent artifact, served by the control plane at /api/download.
COPY --from=agent /out/dam-agent-linux-amd64 /app/artifacts/dam-agent-linux-amd64
EXPOSE 3000
CMD ["node", "main.js"]
