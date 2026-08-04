# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/devcontainers/javascript-node:24-trixie

# Install system tools
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    unzip fd-find ripgrep gh chromium \
    && ln -s $(which fdfind) /usr/local/bin/fd

# Install uv
COPY --from=ghcr.io/astral-sh/uv:0.10.12 /uv /uvx /usr/local/bin/

# Install bun
ENV BUN_INSTALL=/home/node/.bun
RUN mkdir -p /home/node/.bun /home/node/.local/share/opencode \
    && curl -fsSL https://bun.com/install | bash \
    && mkdir -p /home/node/.bun/install/cache /home/node/.bun/bin /home/node/.bun/install/global \
    && chown -R node:node /home/node /home/node/.bun \
    && printf '%s\n' 'export PATH="/home/node/.bun/bin:/usr/local/bin:$PATH"' > /etc/profile.d/devcontainer-path.sh \
    && chmod 755 /etc/profile.d/devcontainer-path.sh
ENV PATH=${BUN_INSTALL}/bin:/usr/local/bin:${PATH}
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

# Install opencode as node user
USER node
RUN --mount=type=cache,id=bun-cache-v2,target=/home/node/.bun/install/cache,uid=1000,gid=1000 \
    bun add --minimum-release-age 604800 -g opencode-ai oh-my-openagent agent-browser typescript-language-server typescript
