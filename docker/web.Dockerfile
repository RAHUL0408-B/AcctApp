FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/
COPY backend/package.json backend/
RUN npm ci -w frontend
COPY frontend frontend
RUN npm run build -w frontend

FROM nginx:alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
# nginx fills ${API_HOSTPORT} into this template when the container starts.
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
ENV API_HOSTPORT=api:3000
EXPOSE 80
