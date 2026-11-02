FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/api
COPY apps/api apps/api
RUN npx tsc -p apps/api/tsconfig.json

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/api --omit=dev && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
COPY db db
# Writable folders for uploaded documents and encrypted backups. Hosts such as Render mount disks owned by root,
# so the container fixes ownership when it starts and then drops to the non-root 'node' user to run the app.
RUN mkdir -p /var/acctapp/data /var/acctapp/backups
EXPOSE 3000
CMD ["sh", "-c", "chown -R node:node /var/acctapp 2>/dev/null; exec runuser -u node -- sh -c 'node apps/api/dist/db/migrate.js && node apps/api/dist/main.js'"]
