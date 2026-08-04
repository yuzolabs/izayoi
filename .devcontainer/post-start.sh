#!/bin/bash
set -e

WORKSPACE_ROOT=${WORKSPACE_ROOT:-/workspace}
WT_NAME=${1:-$(basename "$WORKSPACE_ROOT")}
MAIN_REPO_PATH=${MAIN_REPO_PATH}

echo "=== Dev Container Setup Start ==="
echo "Workspace: $WORKSPACE_ROOT"
echo "Worktree name: $WT_NAME"
echo "Main repo: $MAIN_REPO_PATH"

# git configの初期化（ホスト設定をコピーして使用）
# safe.directory設定より先に実行しないとgit configが反映されない
HOST_GITCONFIG="/host-config/.gitconfig"
CONTAINER_GITCONFIG="$HOME/.gitconfig"

if [ -f "$HOST_GITCONFIG" ] && [ ! -f "$CONTAINER_GITCONFIG" ]; then
    echo "Copying host gitconfig to container..."
    cp "$HOST_GITCONFIG" "$CONTAINER_GITCONFIG"
fi

# メインリポジトリが正しくマウントされているか確認
if [ ! -d "$MAIN_REPO_PATH/.git" ] && [ ! -f "$MAIN_REPO_PATH/.git" ]; then
    echo "ERROR: Main repository not found at $MAIN_REPO_PATH"
    echo "Please ensure the repository is cloned at the expected location."
    exit 1
fi

# worktreeの検出（/workspace/.gitファイルが存在するか）
if [ -f "$WORKSPACE_ROOT/.git" ]; then
    echo "Detected worktree at: $WORKSPACE_ROOT"
    GITDIR_CONTENT=$(cat "$WORKSPACE_ROOT/.git")
    echo "Current .git content: $GITDIR_CONTENT"

    # safe.directory設定
    git config --global --add safe.directory "$WORKSPACE_ROOT" 2>/dev/null || true
fi

# メインリポジトリのsafe.directory設定
git config --global --add safe.directory "$MAIN_REPO_PATH" 2>/dev/null || true

# Gitが正しく機能するか確認
echo "Verifying git configuration..."
if git -C "$WORKSPACE_ROOT" status > /dev/null 2>&1; then
    echo "Git status: OK"
else
    echo "ERROR: Git status check failed. initializeCommand did not produce a valid container worktree mapping." >&2
    echo "Reopen the Dev Container after running the worktree from the expected ../<repo>.worktrees/<branch> layout." >&2
    exit 1
fi

# フックディレクトリの権限設定
if [ -d "$MAIN_REPO_PATH/.git/hooks" ]; then
    sudo chown -R node:node "$MAIN_REPO_PATH/.git/hooks" 2>/dev/null || true
fi

# node_modulesの権限設定（名前付きボリュームがroot所有になる問題の対策）
if [ -d "/workspace/node_modules" ]; then
    sudo chown -R node:node /workspace/node_modules 2>/dev/null || true
fi

# .venvの権限設定（名前付きボリュームがroot所有になる問題の対策）
if [ -d "/workspace/.venv" ]; then
    sudo chown -R node:node /workspace/.venv 2>/dev/null || true
fi

sudo mkdir -p /home/node/.bun/install/cache 2>/dev/null || true
sudo chown -R node:node /home/node/.bun/install/cache 2>/dev/null || true

sudo mkdir -p /home/node/.cache/uv 2>/dev/null || true
sudo chown -R node:node /home/node/.cache 2>/dev/null || true

# opencode設定の初期化（ホスト設定をコピーして使用）
CONTAINER_OPENCODE_CONFIG="/home/node/.config/opencode"
CONTAINER_OPENCODE_SHARE="/home/node/.local/share/opencode"
HOST_OPENCODE_CONFIG="/host-config/opencode/config"
HOST_OPENCODE_SHARE="/host-config/opencode/share"

# コンテナ内にディレクトリを作成
mkdir -p "$CONTAINER_OPENCODE_CONFIG"
mkdir -p "$CONTAINER_OPENCODE_SHARE"

# ホストの設定をコンテナにコピー（既にコピー済みでない場合のみ）
if [ -d "$HOST_OPENCODE_CONFIG" ] && [ ! -f "$CONTAINER_OPENCODE_CONFIG/.copied" ]; then
    echo "Copying host opencode config to container..."
    cp -r "$HOST_OPENCODE_CONFIG/"* "$CONTAINER_OPENCODE_CONFIG/" 2>/dev/null || true
    touch "$CONTAINER_OPENCODE_CONFIG/.copied"
fi

if [ -d "$HOST_OPENCODE_SHARE" ] && [ ! -f "$CONTAINER_OPENCODE_SHARE/.copied" ]; then
    echo "Copying host opencode share data to container..."
    cp -r "$HOST_OPENCODE_SHARE/"* "$CONTAINER_OPENCODE_SHARE/" 2>/dev/null || true
    touch "$CONTAINER_OPENCODE_SHARE/.copied"
fi


# pre-commit hook installation (async - runs in background)
if [ ! -f "$MAIN_REPO_PATH/.git/hooks/pre-commit" ]; then
    echo "Installing pre-commit hooks in background..."
    (
        # サブシェル内で pipefail を有効にし、パイプラインの失敗を検知する
        set -e
        set -o pipefail
        if git -C "$WORKSPACE_ROOT" rev-parse --git-dir > /dev/null 2>&1; then
            cd "$WORKSPACE_ROOT"
            if uv run --active prek install 2>&1 | tee /tmp/prek-install.log; then
                echo "pre-commit hooks installed successfully" >> /tmp/prek-install.log
            else
                # uv run が失敗した場合、その旨をログに記録する
                echo "pre-commit hooks installation failed with exit code $?" >> /tmp/prek-install.log
            fi
        else
            echo "Skipping pre-commit install: Git not properly configured" >> /tmp/prek-install.log
        fi
    ) &
    disown
else
    echo "pre-commit hook already installed"
fi

# pre-commit フックのフォールバック用に prek を PATH 上に用意する
# (フックがホスト側で生成されている場合、ハードコードされたホスト側パスはコンテナ内で無効になり、
#  PATH 上の prek へフォールバックされるため)
if [ -x "$WORKSPACE_ROOT/.venv/bin/prek" ]; then
    sudo ln -sf "$WORKSPACE_ROOT/.venv/bin/prek" /usr/local/bin/prek 2>/dev/null || true
fi

echo "=== Dev Container Setup Complete ==="
