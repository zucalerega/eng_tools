# The YJSP server image (Vault and Yorg), with the web app. Keep the database and files on a volume mounted at /data.
# Build from the repository root (it needs web/ too): docker build -f server/Dockerfile -t yjsp-server .

# The web app: built here, then served by the server.
FROM node:24-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

COPY --from=ghcr.io/astral-sh/uv:0.12.19 /uv /usr/local/bin/uv

WORKDIR /app
# Dependencies first, so code changes don't reinstall them.
COPY server/pyproject.toml server/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY server/src ./src
RUN uv sync --locked --no-dev --no-editable
COPY --from=web /web/dist ./web

RUN useradd --system --uid 10001 --no-create-home yjsp && mkdir /data && chown yjsp /data
USER yjsp

ENV PATH="/app/.venv/bin:$PATH" \
    YJSP_HOST=0.0.0.0 \
    YJSP_PORT=8000 \
    YJSP_DATABASE_URL=sqlite:////data/yjsp.db \
    YJSP_VAULT_DIR=/data/vault \
    YJSP_YORG_DIR=/data/yorg \
    YJSP_WEB_DIR=/app/web
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4)"]
CMD ["yjsp-server"]
