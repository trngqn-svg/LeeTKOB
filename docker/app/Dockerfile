# The app image (task Q4): one image for the API and the judge worker.
# Build it from the repository root; .dockerignore lets in only package*.json,
# tsconfig.json and src/, so no .env and no database can be inside it:
#   docker build --file docker/app/Dockerfile --tag leetkob-app .
# deploy/compose.yaml starts it as `api` and as `worker`.
FROM node:22-bookworm-slim

# The docker command line, for the worker only: it starts the sandbox containers
# (src/judge/sandbox.ts). The API never gets the Docker socket, so for it this binary
# can reach nothing.
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app
# tsx runs the TypeScript, and it is a dev dependency (decision 1), so install them all.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src

# The SQLite file lives on the `data` volume, which the node user owns.
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production \
    DB_PATH=/data/leetkob.db \
    HOST=0.0.0.0 \
    PORT=3000
USER node
EXPOSE 3000

CMD ["./node_modules/.bin/tsx", "src/server.ts"]
