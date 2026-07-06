FROM node:20-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY libs/shared/database/package.json libs/shared/database/
COPY libs/shared/event-contracts/package.json libs/shared/event-contracts/
COPY libs/domain/git-providers/package.json libs/domain/git-providers/
RUN npm install

FROM deps AS build
COPY apps/api apps/api
COPY libs/shared/database libs/shared/database
COPY libs/shared/event-contracts libs/shared/event-contracts
COPY libs/domain/git-providers libs/domain/git-providers
RUN npm run build --workspace=@devsentinel/database \
 && npm run build --workspace=@devsentinel/event-contracts \
 && npm run build --workspace=@devsentinel/git-providers \
 && npm run build --workspace=@devsentinel/api

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/package.json package.json
COPY --from=build /repo/libs libs
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/api/package.json apps/api/package.json
WORKDIR /repo/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]
