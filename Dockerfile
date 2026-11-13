FROM node:22-alpine

WORKDIR /app

RUN npm install --global pnpm@10.30.3

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY servidor.mjs index.html confeti.min.js vista-previa.png cancion.mp3 ./
COPY img ./img

USER node

CMD ["node", "servidor.mjs"]
