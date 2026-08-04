#!/bin/bash
# DevContainer 自動セットアップスクリプト
# postCreateCommand と手動実行の両方で使用

set -e

MINIMUM_RELEASE_AGE_SECONDS=$((7 * 24 * 60 * 60))
EXCLUDE_NEWER_UTC=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)

echo "=== DevContainer Auto Setup ==="
echo "Workspace: /workspace"
echo "Supply chain guard: bun minimumReleaseAge=${MINIMUM_RELEASE_AGE_SECONDS}s, uv exclude-newer=${EXCLUDE_NEWER_UTC}"

# bun install 前に bun キャッシュの権限を修正
# (Apple Container の名前付きボリュームは root 所有の空 ext4 で作成され、イメージ内容がコピーされないため)
if [ -d /home/node/.bun/install/cache ]; then
    sudo chown -R node:node /home/node/.bun/install/cache 2>/dev/null || true
fi

# bun install（冪等性チェック：node_modules が空なら実行）
# Apple Container の名前付きボリュームは ext4 のため lost+found が含まれるが、実質空として扱う
if [ -d /workspace/node_modules ] && [ -n "$(ls -A /workspace/node_modules 2>/dev/null | grep -v '^lost+found$')" ]; then
    echo "✓ node_modules already populated, skipping bun install"
else
    echo "→ Installing bun dependencies..."
    cd /workspace
    # Fix ownership of node_modules volume (created as root by Docker)
    sudo chown -R node:node /workspace/node_modules 2>/dev/null || true
    if [ -f bun.lock ] || [ -f bun.lockb ]; then
        bun install --frozen-lockfile --minimum-release-age "$MINIMUM_RELEASE_AGE_SECONDS"
    else
        bun install --minimum-release-age "$MINIMUM_RELEASE_AGE_SECONDS"
    fi
    echo "✓ bun install completed"
fi

# uv cache 権限修正
if [ -d /home/node/.cache/uv ]; then
    sudo chown -R node:node /home/node/.cache/uv 2>/dev/null || true
fi

# uv sync（冪等性チェック：/workspace/.venv に有効な仮想環境があればスキップ）
if [ -f /workspace/.venv/pyvenv.cfg ]; then
    echo "✓ Python virtual environment already exists at /workspace/.venv, skipping uv sync"
else
    echo "→ Setting up Python environment (uv sync)..."
    cd /workspace
    # Fix ownership of .venv volume (created as root by Docker)
    sudo chown -R node:node /workspace/.venv 2>/dev/null || true
    # Apple Container の ext4 ボリュームには lost+found が存在し、uv は .venv が空でないと失敗するため除去する
    sudo rm -rf /workspace/.venv/lost+found 2>/dev/null || true
    uv sync --exclude-newer "$EXCLUDE_NEWER_UTC"
    echo "✓ uv sync completed"
fi

echo "=== Auto Setup Complete ==="
