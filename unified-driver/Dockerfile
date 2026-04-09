FROM node:20-alpine

RUN npm install -g serve

WORKDIR /app

COPY index.html .
COPY css/ ./css/
COPY js/ ./js/

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["serve", "-s", ".", "-l", "3000"]
