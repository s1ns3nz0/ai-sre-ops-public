# AI SRE Ops console (Next.js standalone). Bundles read-only snapshots of lineth-observability and the gitops CHG
# docs (.repos, no .git) so a demo deployment needs no GitHub token. Also carries db/ and scripts/ for the demo seed:
#   docker run … ai-sre-ops node scripts/demo-seed.ts
# Build: docker build --build-arg NEXT_PUBLIC_BASE_PATH=/sre -t ai-sre-ops:<tag> .
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG NEXT_PUBLIC_BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH NEXT_TELEMETRY_DISABLED=1
RUN npx next build

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1 \
    DETECTION_REPO_DIR=/app/.repos/lineth-observability GITOPS_REPO_DIR=/app/.repos/lineth-l2-gitops
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/node_modules/pg ./node_modules/pg
COPY --from=build /app/node_modules/yaml ./node_modules/yaml
COPY --from=build /app/node_modules/zod ./node_modules/zod
COPY topology.yaml shifts.yaml ./
COPY db ./db
COPY scripts ./scripts
COPY lib ./lib
COPY fixtures ./fixtures
COPY .repos ./.repos
USER node
EXPOSE 3000
CMD ["node", "server.js"]
