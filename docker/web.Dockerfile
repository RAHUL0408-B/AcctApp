FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN npm ci -w apps/web
COPY apps/web apps/web
RUN npm run build -w apps/web

FROM nginx:alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
# nginx fills ${API_HOSTPORT} into this template when the container starts.
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
ENV API_HOSTPORT=api:3000
EXPOSE 80
