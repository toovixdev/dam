FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY consumer.js ingest.js sources.js normalize.js ./
CMD ["node", "consumer.js"]
