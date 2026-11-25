# Runs the Worker locally (workerd via `wrangler dev`) with D1 and R2 kept on a volume.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --config.dangerouslyAllowAllBuilds=true
COPY . .
RUN pnpm build:admin
ENV WRANGLER_SEND_METRICS=false CI=1 HOME=/tmp
EXPOSE 8787
# HTTPS (self-signed) so the Worker sees https:// URLs behind a tunnel: Secure cookies and OAuth redirects depend on it.
CMD ["sh", "-c", "node_modules/.bin/wrangler d1 migrations apply cosycms --local --persist-to /data && exec node_modules/.bin/wrangler dev --ip 0.0.0.0 --port 8787 --local-protocol https --persist-to /data"]
