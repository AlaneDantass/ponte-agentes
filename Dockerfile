FROM node:22-slim
WORKDIR /app
COPY server.mjs .
ENV PORT=8080 DB_PATH=/data/ponte.db NODE_NO_WARNINGS=1
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "server.mjs"]
