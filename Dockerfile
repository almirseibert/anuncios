FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=development

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data UPLOADS_DIR=/app/data/uploads DB_FILE=/app/data/anuncios.db
EXPOSE 3000
VOLUME ["/app/data"]

CMD ["npm", "start"]
