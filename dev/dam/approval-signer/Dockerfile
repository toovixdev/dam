FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY main.js ./
EXPOSE 3100
CMD ["node", "main.js"]
