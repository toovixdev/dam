FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY consumer.js ./
CMD ["node", "consumer.js"]
