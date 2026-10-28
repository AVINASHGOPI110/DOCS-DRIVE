FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV DOCS_DRIVE_DATA_DIR=/data
COPY server.mjs index.html app.js ./
EXPOSE 3000
CMD ["node", "server.mjs"]
