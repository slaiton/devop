FROM node:20-slim AS deps
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/
COPY libs/shared/database/package.json libs/shared/database/
COPY libs/shared/event-contracts/package.json libs/shared/event-contracts/
COPY libs/domain/git-providers/package.json libs/domain/git-providers/
COPY libs/domain/llm-port/package.json libs/domain/llm-port/
RUN npm install

FROM deps AS build
COPY apps/worker apps/worker
COPY libs/shared/database libs/shared/database
COPY libs/shared/event-contracts libs/shared/event-contracts
COPY libs/domain/git-providers libs/domain/git-providers
COPY libs/domain/llm-port libs/domain/llm-port
RUN npm run build --workspace=@devsentinel/database \
 && npm run build --workspace=@devsentinel/event-contracts \
 && npm run build --workspace=@devsentinel/git-providers \
 && npm run build --workspace=@devsentinel/llm-port \
 && npm run build --workspace=@devsentinel/worker

FROM node:20-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/package.json package.json
COPY --from=build /repo/libs libs
COPY --from=build /repo/apps/worker/dist apps/worker/dist
COPY --from=build /repo/apps/worker/package.json apps/worker/package.json
WORKDIR /repo/apps/worker
CMD ["node", "dist/main.js"]
