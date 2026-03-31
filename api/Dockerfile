FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/logs
EXPOSE 3000
CMD ["node", "api/server.js"]