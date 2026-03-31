FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY shared/ ./shared/
COPY monitoring/ ./monitoring/
COPY db/ ./db/
RUN mkdir -p /app/logs
EXPOSE 4000
CMD ["node", "monitoring/dashboard.js"]