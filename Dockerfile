FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN mkdir -p /data
ENV DATABASE_PATH=/data/chat.db
EXPOSE 3000
CMD ["node", "server.js"]
