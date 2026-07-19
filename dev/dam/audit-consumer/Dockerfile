FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
# Listed explicitly rather than `COPY . .` to keep the image lean — so a NEW module must be
# added here too, or it is silently missing at runtime and its source fails to start.
COPY consumer.js ingest.js sources.js normalize.js checkpoint-store.js ./
CMD ["node", "consumer.js"]
