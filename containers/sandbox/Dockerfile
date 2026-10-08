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
ARG WITH_CLAUDE=0
COPY scripts/install-claude-code-probe.mjs /tmp/install-claude-code-probe.mjs
RUN if [ "$WITH_CLAUDE" = "1" ]; then node /tmp/install-claude-code-probe.mjs /opt/claude; fi && rm /tmp/install-claude-code-probe.mjs
ENV HARNESS_SANDBOX_REFERENCE_WAIT=${REFERENCE_WAIT}
COPY --from=build /runtime /app/apps/sandbox-runtime
USER 65532:65532
WORKDIR /home/sandbox
ENTRYPOINT ["node", "/app/apps/sandbox-runtime/dist/main.js"]
