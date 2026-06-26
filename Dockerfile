FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache python3

COPY package.json ./
COPY package-lock.json ./
RUN npm ci --omit=dev

COPY server.mjs tdx_bridge.py ./
COPY data/demo ./data/demo
COPY public ./public
COPY docs ./docs

ENV PORT=3100
ENV TDX_PYTHON=python3

EXPOSE 3100

CMD ["npm", "start"]
