# ─── Builder ─────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Declare build args so Railway env vars are visible during Vite build
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ─── Production (Railway) ───────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

RUN npm install -g serve

COPY --from=builder /app/dist ./dist

ENV PORT=80
EXPOSE 80

CMD ["sh", "-c", "serve dist -l $PORT -s"]

# ─── Local with nginx (docker-compose) ──────────────────────────────────────
FROM nginx:alpine AS local
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
ENV BACKEND_URL=http://localhost:3000
ENV PORT=80
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

# ─── Development ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS development
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev"]
