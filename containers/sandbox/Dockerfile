# Supply an immutable official Node repository digest after pulling the pinned version.
ARG NODE_BASE
FROM ${NODE_BASE} AS build
WORKDIR /source
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @yanbot-harness/sandbox-runtime... build \
    && pnpm --filter @yanbot-harness/sandbox-runtime deploy --prod /runtime

FROM ${NODE_BASE}
ARG REFERENCE_WAIT=0
ENV HARNESS_SANDBOX_REFERENCE_WAIT=${REFERENCE_WAIT}
COPY --from=build /runtime /app/apps/sandbox-runtime
USER 65532:65532
WORKDIR /home/sandbox
ENTRYPOINT ["node", "/app/apps/sandbox-runtime/dist/main.js"]
