#!/usr/bin/env bash
set -eu

WORKSPACE_DIR=${1:-}
WORKSPACE_NAME=${2:-}
CONTAINER_MAIN_REPO_PATH=${3:-}
CONTAINER_WORKSPACE_PATH=${4:-/workspace}

if [ -z "$WORKSPACE_DIR" ]; then
    echo "ERROR: workspace path is required" >&2
    exit 1
fi

if [ -z "$WORKSPACE_NAME" ]; then
    WORKSPACE_NAME=$(basename "$WORKSPACE_DIR")
fi

WORKSPACE_GIT_FILE="$WORKSPACE_DIR/.git"

if [ -d "$WORKSPACE_GIT_FILE" ]; then
    exit 0
fi

if [ ! -f "$WORKSPACE_GIT_FILE" ]; then
    exit 0
fi

CURRENT_HOST_GIT_FILE_CONTENT=$(tr -d '\r' < "$WORKSPACE_GIT_FILE")
CURRENT_HOST_GITDIR=${CURRENT_HOST_GIT_FILE_CONTENT#gitdir: }
CURRENT_HOST_GITDIR_NORMALIZED=${CURRENT_HOST_GITDIR//\\//}

WORKSPACE_PARENT=$(dirname "$WORKSPACE_DIR")
WORKTREE_ROOT_NAME=$(basename "$WORKSPACE_PARENT")

if [ "${WORKTREE_ROOT_NAME#*.worktrees}" = "$WORKTREE_ROOT_NAME" ]; then
    echo "ERROR: worktree workspace must live under a '*.worktrees' directory: $WORKSPACE_DIR" >&2
    exit 1
fi

REPO_NAME=${WORKTREE_ROOT_NAME%.worktrees}
MAIN_REPO_DIR=$(dirname "$WORKSPACE_PARENT")/$REPO_NAME
MAIN_REPO_GIT_DIR="$MAIN_REPO_DIR/.git"
WORKTREE_ADMIN_DIR_NAME=$(basename "$CURRENT_HOST_GITDIR_NORMALIZED")

if [ "$WORKTREE_ADMIN_DIR_NAME" != "$WORKSPACE_NAME" ]; then
    echo "ERROR: worktree admin dir '$WORKTREE_ADMIN_DIR_NAME' does not match workspace directory '$WORKSPACE_NAME'." >&2
    echo "This Dev Container configuration requires matching names for deterministic Git overlays." >&2
    exit 1
fi

EXPECTED_WORKTREE_GITDIR="$MAIN_REPO_GIT_DIR/worktrees/$WORKTREE_ADMIN_DIR_NAME"

if [ -z "$CONTAINER_MAIN_REPO_PATH" ]; then
    CONTAINER_MAIN_REPO_PATH="/workspaces/$REPO_NAME"
fi

if [ ! -d "$MAIN_REPO_GIT_DIR" ]; then
    echo "ERROR: expected main repository git directory was not found: $MAIN_REPO_GIT_DIR" >&2
    echo "Ensure worktrees are located at ../$REPO_NAME.worktrees/<branch-name>." >&2
    exit 1
fi

if command -v git >/dev/null 2>&1; then
    git -C "$MAIN_REPO_DIR" worktree repair "$WORKSPACE_DIR" >/dev/null 2>&1 || true
fi

if [ ! -d "$EXPECTED_WORKTREE_GITDIR" ]; then
    echo "ERROR: expected worktree metadata directory was not found: $EXPECTED_WORKTREE_GITDIR" >&2
    echo "Create the worktree from the main repository before reopening in Dev Container." >&2
    exit 1
fi

GENERATED_GIT_FILE="$WORKSPACE_DIR/.devcontainer/.git-container"
GENERATED_GITDIR_FILE="$WORKSPACE_DIR/.devcontainer/.gitdir-container"
EXPECTED_CONTAINER_GIT_FILE_CONTENT="gitdir: $CONTAINER_MAIN_REPO_PATH/.git/worktrees/$WORKTREE_ADMIN_DIR_NAME"
EXPECTED_CONTAINER_GITDIR_FILE_CONTENT="$CONTAINER_WORKSPACE_PATH/.git"

CURRENT_CONTAINER_GIT_FILE_CONTENT=""
if [ -f "$GENERATED_GIT_FILE" ]; then
    CURRENT_CONTAINER_GIT_FILE_CONTENT=$(tr -d '\r' < "$GENERATED_GIT_FILE")
fi

if [ "$CURRENT_CONTAINER_GIT_FILE_CONTENT" != "$EXPECTED_CONTAINER_GIT_FILE_CONTENT" ]; then
    printf '%s\n' "$EXPECTED_CONTAINER_GIT_FILE_CONTENT" > "$GENERATED_GIT_FILE"
fi

CURRENT_CONTAINER_GITDIR_FILE_CONTENT=""
if [ -f "$GENERATED_GITDIR_FILE" ]; then
    CURRENT_CONTAINER_GITDIR_FILE_CONTENT=$(tr -d '\r' < "$GENERATED_GITDIR_FILE")
fi

if [ "$CURRENT_CONTAINER_GITDIR_FILE_CONTENT" != "$EXPECTED_CONTAINER_GITDIR_FILE_CONTENT" ]; then
    printf '%s\n' "$EXPECTED_CONTAINER_GITDIR_FILE_CONTENT" > "$GENERATED_GITDIR_FILE"
fi

ENV_FILE="$WORKSPACE_DIR/.devcontainer/.env"
CONTAINER_WORKTREES_PATH="/workspaces/${REPO_NAME}.worktrees"
COMPOSE_PROJECT_NAME="$(echo "$REPO_NAME" | tr '[:upper:]' '[:lower:]')-${WORKSPACE_NAME}"

EXPECTED_ENV_CONTENT="MAIN_REPO_PATH=${CONTAINER_MAIN_REPO_PATH}
WORKTREES_PATH=${CONTAINER_WORKTREES_PATH}
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME}"

CURRENT_ENV_CONTENT=""
if [ -f "$ENV_FILE" ]; then
    CURRENT_ENV_CONTENT=$(cat "$ENV_FILE" 2>/dev/null || true)
fi

if [ "$CURRENT_ENV_CONTENT" != "$EXPECTED_ENV_CONTENT" ]; then
    printf '%s\n' "$EXPECTED_ENV_CONTENT" > "$ENV_FILE"
fi

convert_wsl_path_to_windows() {
    local wsl_path="$1"
    if [[ "$wsl_path" =~ ^/mnt/([a-z])/(.*)$ ]]; then
        local drive="${BASH_REMATCH[1]}"
        local rest="${BASH_REMATCH[2]}"
        echo "${drive^^}:/${rest}"
    else
        echo "$wsl_path"
    fi
}

repair_host_git_file() {
    local git_file="$WORKSPACE_DIR/.git"

    if [ ! -f "$git_file" ] || [ -d "$git_file" ]; then
        return 0
    fi

    local current_content
    current_content=$(tr -d '\r' < "$git_file")

    if echo "$current_content" | grep -q "^gitdir: /mnt/"; then
        echo "[INFO] Repairing host .git file (converting WSL path to Windows path)..."

        local wsl_path
        wsl_path=$(echo "$current_content" | sed 's/^gitdir: //')

        local windows_path
        windows_path=$(convert_wsl_path_to_windows "$wsl_path")

        printf 'gitdir: %s\n' "$windows_path" > "$git_file"
        echo "[INFO] Host .git file repaired: $windows_path"
    fi
}

repair_host_git_file
