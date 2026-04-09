FROM node:20-alpine

WORKDIR /app

COPY server.js .
COPY index.html .
COPY css/ ./css/
COPY js/ ./js/

RUN mkdir -p data && \
    addgroup -S appgroup && adduser -S appuser -G appgroup && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/status || exit 1

CMD ["node", "server.js"]
