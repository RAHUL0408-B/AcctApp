FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci -w backend
COPY backend backend
RUN npx tsc -p backend/tsconfig.json

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci -w backend --omit=dev && npm cache clean --force
COPY --from=build /app/backend/dist backend/dist
COPY db db
# Writable folders for uploaded documents and encrypted backups. Hosts such as Render mount disks owned by root,
# so the container fixes ownership when it starts and then drops to the non-root 'node' user to run the app.
RUN mkdir -p /var/acctapp/data /var/acctapp/backups
EXPOSE 3000
CMD ["sh", "-c", "chown -R node:node /var/acctapp 2>/dev/null; exec runuser -u node -- sh -c 'node backend/dist/db/migrate.js && node backend/dist/main.js'"]
