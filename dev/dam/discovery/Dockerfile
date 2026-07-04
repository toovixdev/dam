FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY portsets.js scanner.js agent.js ./
CMD ["node", "agent.js"]
