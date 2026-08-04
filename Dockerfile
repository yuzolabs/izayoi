# syntax=docker/dockerfile:1
# izayoi — multi-stage image: bun builds the SPA, python:3.12-slim serves it.
# No heavyweight ML dependencies anywhere (SPEC C3), so the image stays small.

# ---------------------------------------------------------------------------
# Stage 1: build the frontend
# ---------------------------------------------------------------------------
FROM oven/bun:1 AS frontend
WORKDIR /build
COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile
COPY frontend/ ./
RUN bun run build

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./backend/
COPY SPEC.md ./
COPY --from=frontend /build/dist ./frontend/dist

# The container binds 0.0.0.0 so port publishing works; on a developer machine
# the default (outside Docker) stays 127.0.0.1. API keys arrive via env only.
ENV IZAYOI_HOST=0.0.0.0 \
    IZAYOI_PORT=8787 \
    IZAYOI_DB_PATH=/data/izayoi.db
VOLUME ["/data"]
EXPOSE 8787

CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8787"]
