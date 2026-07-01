FROM node:lts-alpine

# git: needed by Ep 6 GitHub auto-commit. openssh-client kept available for
# future SSH-based auth if we ever swap off PAT.
RUN apk add --no-cache git openssh-client postgresql-client

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

CMD ["node", "src/index.js"]
