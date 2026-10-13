# lineth-tools (MCP server) and executor for the P2 agents: one image, two entrypoints. TypeScript runs directly
# (Node 24 strips types). Only the two runtime dependencies are installed.
# Build: docker build -f tools/Dockerfile -t ai-sre-ops-tools:<tag> . && kind load docker-image ai-sre-ops-tools:<tag> --name lineth-local
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
RUN echo '{"type":"module","private":true}' > package.json \
 && npm install --no-audit --no-fund --save-exact @modelcontextprotocol/sdk@1.30.1 zod@4.6.7 \
 && npm cache clean --force
COPY lib/actions.ts lib/bearer.ts lib/briefing.ts lib/redact.ts lib/
COPY tools/lineth-tools.ts tools/executor.ts tools/
ENV NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
USER node
CMD ["node", "tools/lineth-tools.ts"]
