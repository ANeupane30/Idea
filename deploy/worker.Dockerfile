# The job worker and the lesson server (one image, two Fly process groups). Build context: repo root.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH" \
    MERMAID_JS_PATH=/opt/mermaid/mermaid.min.js \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    LESSON_SERVER_HOST=0.0.0.0 \
    LESSON_SERVER_PORT=8787

COPY --from=ghcr.io/astral-sh/uv:0.13.0 /uv /usr/local/bin/uv

# mermaid.js validates lesson diagrams in headless Chromium; same version as the web app.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && mkdir -p /opt/mermaid \
 && curl -fsSL https://registry.npmjs.org/mermaid/-/mermaid-12.2.0.tgz | tar -xz -C /tmp \
 && cp /tmp/package/dist/mermaid.min.js /opt/mermaid/ \
 && rm -rf /tmp/package /var/lib/apt/lists/*

WORKDIR /app
COPY worker/pyproject.toml worker/uv.lock worker/.python-version ./
RUN uv sync --locked --no-dev --no-install-project
COPY worker/src ./src
RUN uv sync --locked --no-dev \
 && playwright install --with-deps chromium

# The embedding model ships in the image, so jobs never wait for a download.
ENV FASTEMBED_CACHE_PATH=/opt/fastembed
RUN python -c "from fastembed import TextEmbedding; TextEmbedding('BAAI/bge-small-en-v1.5', cache_dir='/opt/fastembed')"

# Run as an unprivileged user (Chromium's sandbox needs one).
RUN useradd --create-home app && chown -R app /app /opt/fastembed
USER app

CMD ["python", "-m", "worker"]
