# The constraint checker image (task L4; docs/ARCHITECTURE.md, section 5.3).
# Build from the repository root:
#   docker build --file docker/checker/Dockerfile --tag leetkob-checker .
# Run offline against a dataset folder:
#   docker run --rm --network none -e MODEL_OFF=1 \
#     -v "$PWD/leetkob-eval:/data:ro" -v "$PWD/out:/out" \
#     leetkob-checker --data /data --output /out/predictions.jsonl
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
USER node

ENTRYPOINT ["./node_modules/.bin/tsx", "src/checker/cli.ts"]
