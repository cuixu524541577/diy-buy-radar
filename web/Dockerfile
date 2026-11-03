FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
COPY web/package.json ./web/
RUN npm install --workspace=web
COPY web ./web
WORKDIR /app/web
ARG VITE_API_BASE=http://localhost:3001
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

FROM nginx:alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
