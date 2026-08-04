#!/bin/bash

set -e

WORKSPACE_PATH="${PWD}"
COMMAND_TEXT="bash"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    -WorkspacePath)
      if [[ -z "$2" ]]; then
        echo "[ERROR] -WorkspacePath requires a value."
        exit 1
      fi
      WORKSPACE_PATH="$2"
      shift 2
      ;;
    -Command)
      if [[ -z "$2" ]]; then
        echo "[ERROR] -Command requires a value."
        exit 1
      fi
      COMMAND_TEXT="$2"
      shift 2
      ;;
    *)
      echo "[ERROR] Unknown argument: $1"
      exit 1
      ;;
  esac
done

# Get absolute path
WORKSPACE_PATH="$(cd "$WORKSPACE_PATH" && pwd)"
echo "[INFO] Workspace: $WORKSPACE_PATH"

WORKSPACE_NAME="$(basename "$WORKSPACE_PATH")"
echo "[INFO] Workspace name: $WORKSPACE_NAME"

# Check if Docker is running
if ! docker version --format '{{.Server.Version}}' &>/dev/null; then
  echo "[ERROR] Docker is not running. Please start Docker."
  exit 1
fi

# Initialize DevContainer
INIT_SCRIPT="${WORKSPACE_PATH}/.devcontainer/host-initialize.sh"
echo "[INFO] Initializing DevContainer configuration..."
if [[ -f "$INIT_SCRIPT" ]]; then
  if ! bash "$INIT_SCRIPT" "$WORKSPACE_PATH" "$WORKSPACE_NAME" "/workspaces/my-repository-template" "/workspace"; then
    echo "[WARNING] Initialization script failed, but continuing..."
  fi
else
  echo "[INFO] host-initialize.sh not found, skipping initialization"
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

repair_git_file() {
  local git_file="$1"

  if [[ ! -f "$git_file" || -d "$git_file" ]]; then
    return 0
  fi

  local current_content
  current_content=$(tr -d '\r' < "$git_file")

  if echo "$current_content" | grep -q "^gitdir: /mnt/"; then
    echo "[INFO] Repairing .git file (converting WSL path to Windows path)..."

    local wsl_path
    wsl_path=$(echo "$current_content" | sed 's/^gitdir: //')

    local windows_path
    windows_path=$(convert_wsl_path_to_windows "$wsl_path")

    printf 'gitdir: %s\n' "$windows_path" > "$git_file"
    echo "[INFO] .git file repaired: $windows_path"
  fi
}

repair_git_file "$WORKSPACE_PATH/.git"

# Check if command is interactive
is_interactive() {
  local cmd="$1"
  case "$cmd" in
    bash|"bash -i"|"bash -l"|sh|"sh -i"|"sh -l"|zsh|"zsh -i"|"zsh -l")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# Run command and capture output
RUN_OUTPUT_FILE=""
RUN_EXIT_CODE=0

run_capture() {
  local cmd="$1"
  RUN_OUTPUT_FILE=$(mktemp)
  echo "[INFO] Running devcontainer exec..."
  echo "Execute: devcontainer exec --workspace-folder \"$WORKSPACE_PATH\" bash -lc \"$cmd\""
  # Temporarily disable exit on error to capture exit code
  set +e
  if [[ -n "${GH_TOKEN_VALUE:-}" ]]; then
    GH_TOKEN="$GH_TOKEN_VALUE" devcontainer exec --workspace-folder "$WORKSPACE_PATH" bash -lc "$cmd" >"$RUN_OUTPUT_FILE" 2>&1
  else
    devcontainer exec --workspace-folder "$WORKSPACE_PATH" bash -lc "$cmd" >"$RUN_OUTPUT_FILE" 2>&1
  fi
  RUN_EXIT_CODE=$?
  set -e
}

# Start container
start_container() {
  echo "[INFO] Starting DevContainer..."

  # Check if devcontainer CLI is installed
  if ! command -v devcontainer &>/dev/null; then
    echo "[INFO] Installing DevContainer CLI..."
    if ! npm install -g @devcontainers/cli; then
      echo "[ERROR] Failed to install DevContainer CLI"
      exit 1
    fi
  fi

  # Check Docker again
  if ! docker version --format '{{.Server.Version}}' &>/dev/null; then
    echo "[ERROR] Docker is not running. Please start Docker."
    exit 1
  fi

  # Get GitHub token (logs only status, never the token value)
  echo "[INFO] Checking GitHub token..."
  GH_TOKEN_VALUE=""
  GH_TOKEN_SOURCE=""
  if [[ -n "${GH_TOKEN:-}" ]]; then
    GH_TOKEN_VALUE="$GH_TOKEN"
    GH_TOKEN_SOURCE="environment"
    echo "[INFO] GH_TOKEN found in environment variables."
  else
    echo "[INFO] Attempting to retrieve token via 'gh auth token'..."
    GH_TOKEN_RESULT=$(gh auth token 2>/dev/null || echo "__GH_TOKEN_NOT_FOUND__")
    if [[ "$GH_TOKEN_RESULT" == "__GH_TOKEN_NOT_FOUND__" ]]; then
      echo "[WARNING] Failed to retrieve token from 'gh auth token'. GitHub CLI may not be authenticated."
    elif [[ -z "$GH_TOKEN_RESULT" ]]; then
      echo "[WARNING] 'gh auth token' returned empty. GitHub CLI may not be authenticated."
    else
      GH_TOKEN_VALUE="$GH_TOKEN_RESULT"
      GH_TOKEN_SOURCE="gh_cli"
      echo "[INFO] Successfully retrieved token from GitHub CLI."
    fi
  fi

  # Log token presence without exposing the value
  if [[ -n "$GH_TOKEN_VALUE" ]]; then
    # Show only first 3 chars, mask the rest (e.g., ghp********)
    TOKEN_PREFIX="${GH_TOKEN_VALUE:0:3}"
    TOKEN_MASK="${TOKEN_PREFIX}********"
    echo "[INFO] GH_TOKEN is set (${GH_TOKEN_SOURCE}, masked: ${TOKEN_MASK})"
  else
    echo "[INFO] GH_TOKEN is not set. Continuing without authentication."
  fi

  echo "[INFO] Running devcontainer up..."
  if [[ -n "$GH_TOKEN_VALUE" ]]; then
    # Log command without exposing GH_TOKEN value
    echo "Execute: devcontainer up --workspace-folder \"$WORKSPACE_PATH\" (with GH_TOKEN from ${GH_TOKEN_SOURCE})"
    GH_TOKEN="$GH_TOKEN_VALUE" devcontainer up --workspace-folder "$WORKSPACE_PATH"
  else
    echo "Execute: devcontainer up --workspace-folder \"$WORKSPACE_PATH\""
    devcontainer up --workspace-folder "$WORKSPACE_PATH"
  fi

  if [[ $? -ne 0 ]]; then
    echo "[ERROR] Failed to start DevContainer"
    exit 1
  fi

  echo "[INFO] Container started successfully"
}

# Main execution
INITIAL_COMMAND="$COMMAND_TEXT"
if is_interactive "$COMMAND_TEXT"; then
  INITIAL_COMMAND="true"
fi

run_capture "$INITIAL_COMMAND"
EXEC_EXIT_CODE=$RUN_EXIT_CODE

# If failed, check if container needs to be started
if [[ $EXEC_EXIT_CODE -ne 0 ]]; then
  if grep -qiE "(Dev container not found|Container not found|Shell server terminated|is not running)" "$RUN_OUTPUT_FILE" 2>/dev/null; then
    echo "[WARNING] Dev container is unavailable. Starting container..."
    if ! start_container; then
      exit $?
    fi
    echo "[INFO] Container started. Retrying exec command..."
    run_capture "$INITIAL_COMMAND"
    EXEC_EXIT_CODE=$RUN_EXIT_CODE
  fi
fi

# Handle interactive mode
if is_interactive "$COMMAND_TEXT"; then
  rm -f "$RUN_OUTPUT_FILE" 2>/dev/null || true
  echo "[INFO] Entering interactive shell. Type 'exit' to return."
  echo "[INFO] Running interactive shell..."
  echo "Execute: devcontainer exec --workspace-folder \"$WORKSPACE_PATH\" bash"
  EXIT_CODE=0
  if [[ -n "${GH_TOKEN_VALUE:-}" ]]; then
    GH_TOKEN="$GH_TOKEN_VALUE" devcontainer exec --workspace-folder "$WORKSPACE_PATH" bash || EXIT_CODE=$?
  else
    devcontainer exec --workspace-folder "$WORKSPACE_PATH" bash || EXIT_CODE=$?
  fi
  exit $EXIT_CODE
fi

# Output result and exit
cat "$RUN_OUTPUT_FILE"
if [[ $EXEC_EXIT_CODE -ne 0 ]]; then
  echo "[ERROR] Command execution failed (exit code: $EXEC_EXIT_CODE)"
  rm -f "$RUN_OUTPUT_FILE" 2>/dev/null || true
  exit $EXEC_EXIT_CODE
fi

rm -f "$RUN_OUTPUT_FILE" 2>/dev/null || true
exit 0
