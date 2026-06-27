FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY generate.js ./
CMD ["node", "generate.js"]
