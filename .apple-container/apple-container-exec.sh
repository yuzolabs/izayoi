#!/bin/bash
# Apple Container 実行スクリプト (macOS 専用)
#
# Dev Container (.devcontainer/scripts/devcontainer-exec.sh) の macOS 向け代替。
# 同一の .devcontainer/Dockerfile からイメージをビルドし、同一のマウント構成・
# ライフサイクルスクリプト (host-initialize.sh / auto-setup.sh / post-start.sh /
# check-mounts.sh) を使って、Apple Container (https://github.com/apple/container) 上に
# Dev Container と同等の開発環境を構築する。
#
# Dev Container との主な差異:
#   - ポート転送: VS Code の自動ポート転送の代わりに、コンテナに割り当てられる
#     固有 IP (192.168.64.x) へ直接アクセスする。worktree 間でポートは衝突しない。
#     ホスト側に固定公開したい場合は AC_PORTS を指定する。
#   - ライフサイクル順序: check-mounts.sh はセットアップ完了後の検証として実行する
#     (Dev Container では postCreateCommand として先に実行される)。

set -e

WORKSPACE_PATH="${PWD}"
COMMAND_TEXT="bash"
ACTION="exec"
FORCE_BUILD=0
ASSUME_YES=0

AC_CPUS="${AC_CPUS:-4}"
AC_MEMORY="${AC_MEMORY:-8G}"

WORKSPACE_NAME=""
REPO_NAME=""
MAIN_REPO_DIR=""
CONTAINER_NAME=""
IMAGE_TAG=""
GH_TOKEN_VALUE=""
VOLUME_NAMES=()
DNS_SERVERS=()

log_info()  { [[ "${QUIET:-0}" == "1" ]] || echo "[INFO] $*"; }
log_warn()  { echo "[WARNING] $*"; }
log_error() { echo "[ERROR] $*" >&2; }

usage() {
  cat <<'EOF'
Usage: apple-container-exec.sh [action] [options]

Builds and runs a development environment with Apple Container instead of
the Dev Container (macOS only).

Actions:
  exec    Start the container and run a command (default).
          Creates the container and runs the setup scripts first if needed.
  up      Only create/start the container and run the setup scripts.
  build   Rebuild the image (.devcontainer/Dockerfile).
  stop    Stop the container.
  down    Stop and remove the container (volumes are kept).
  clean   Remove the container and its named volumes
          (node_modules / .venv / caches).
  status  Show the container state, IP address, and volumes.
  ip      Print only the container IP address.

Options:
  -WorkspacePath <path>  Path to the worktree (default: current directory)
  -Command <cmd>         Command to run with the exec action (default: bash)
  --build                Force an image rebuild before up/exec
  -y, --yes              Skip the confirmation prompt of clean
  -h, --help             Show this help

Environment variables:
  AC_CPUS        Number of CPUs allocated to the container (default: 4)
  AC_MEMORY      Memory allocated to the container (default: 8G)
  AC_PORTS       Ports to publish on the host (space-separated.
                 e.g. "3000:3000 127.0.0.1:8080:8000")
  AC_DNS_DOMAIN  DNS domain for resolving the container by name (e.g. test).
                 Runs 'container system dns create' with sudo if not registered.
  AC_DNS_SERVERS DNS servers used by the container (space-separated).
                 Defaults to the IPv4 DNS servers detected on the host.
  AC_NO_SETUP    Skip auto-setup.sh / post-start.sh when set to 1
  GH_TOKEN       GitHub token (falls back to 'gh auth token' if unset)

Examples:
  # Enter an interactive shell
  .apple-container/apple-container-exec.sh

  # Run a command once
  .apple-container/apple-container-exec.sh exec -Command "bun run test"

  # Reset the environment
  .apple-container/apple-container-exec.sh clean
EOF
}

# ---------------------------------------------------------------------------
# 前提条件チェック
# ---------------------------------------------------------------------------

ensure_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    log_error "Apple Container is only available on macOS. Use .devcontainer/scripts/devcontainer-exec.sh instead."
    exit 1
  fi
  if [[ "$(uname -m)" != "arm64" ]]; then
    log_error "Apple Container requires a Mac with Apple silicon."
    exit 1
  fi
}

ensure_container_cli() {
  if ! command -v container &>/dev/null; then
    log_error "'container' CLI is not installed."
    echo "Install the signed package from https://github.com/apple/container/releases" >&2
    echo "and then run 'container system start'." >&2
    exit 1
  fi
}

ensure_system_running() {
  if ! container system status 2>/dev/null | grep -q "^status[[:space:]]*running"; then
    log_info "Starting container system services..."
    container system start
  fi
}

preflight() {
  ensure_macos
  ensure_container_cli
  ensure_system_running
}

# ---------------------------------------------------------------------------
# ワークスペース解決 (Dev Container と同じく git worktree レイアウトを前提とする)
# ---------------------------------------------------------------------------

sanitize_name() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//'
}

resolve_workspace() {
  if [[ ! -d "$WORKSPACE_PATH" ]]; then
    log_error "Workspace path does not exist: $WORKSPACE_PATH"
    exit 1
  fi
  WORKSPACE_PATH="$(cd "$WORKSPACE_PATH" && pwd)"
  WORKSPACE_NAME="$(basename "$WORKSPACE_PATH")"
  log_info "Workspace: $WORKSPACE_PATH"

  if [[ ! -e "$WORKSPACE_PATH/.git" ]]; then
    log_error "$WORKSPACE_PATH is not a git repository / worktree."
    exit 1
  fi
  if [[ -d "$WORKSPACE_PATH/.git" ]]; then
    log_error "This environment requires a git worktree layout (same constraint as the Dev Container configuration)."
    echo "Create a worktree first and run this script from it:" >&2
    echo "  git worktree add ../<repo>.worktrees/<branch> -b <branch>" >&2
    exit 1
  fi

  local parent_dir parent_name
  parent_dir="$(dirname "$WORKSPACE_PATH")"
  parent_name="$(basename "$parent_dir")"
  if [[ "$parent_name" != *.worktrees ]]; then
    log_error "Worktree must live under a '*.worktrees' directory: $WORKSPACE_PATH"
    exit 1
  fi
  REPO_NAME="${parent_name%.worktrees}"
  MAIN_REPO_DIR="$(dirname "$parent_dir")/$REPO_NAME"
  if [[ ! -d "$MAIN_REPO_DIR/.git" ]]; then
    log_error "Main repository not found: $MAIN_REPO_DIR"
    exit 1
  fi

  CONTAINER_NAME="$(sanitize_name "${REPO_NAME}-${WORKSPACE_NAME}")"
  IMAGE_TAG="$(sanitize_name "$REPO_NAME")-devcontainer:latest"
  if [[ -z "$CONTAINER_NAME" ]]; then
    log_error "Failed to derive a valid container name from '${REPO_NAME}-${WORKSPACE_NAME}'."
    exit 1
  fi
  log_info "Container name: $CONTAINER_NAME"
}

# host-initialize.sh を実行して worktree 用の git オーバーレイを生成する
# (.devcontainer/.git-container / .devcontainer/.gitdir-container)
run_host_initialize() {
  local init_script="$WORKSPACE_PATH/.devcontainer/host-initialize.sh"
  if [[ ! -f "$init_script" ]]; then
    log_error ".devcontainer/host-initialize.sh not found in $WORKSPACE_PATH"
    exit 1
  fi
  log_info "Initializing worktree git overlays..."
  bash "$init_script" "$WORKSPACE_PATH" "$WORKSPACE_NAME" "/workspaces/$REPO_NAME" "/workspace"

  if [[ ! -f "$WORKSPACE_PATH/.devcontainer/.git-container" ]] || [[ ! -f "$WORKSPACE_PATH/.devcontainer/.gitdir-container" ]]; then
    log_error "host-initialize.sh did not generate the git overlay files."
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# 認証・ホスト側設定ファイル
# ---------------------------------------------------------------------------

resolve_gh_token() {
  GH_TOKEN_VALUE=""
  if [[ -n "${GH_TOKEN:-}" ]]; then
    GH_TOKEN_VALUE="$GH_TOKEN"
    log_info "GH_TOKEN found in environment variables."
    return 0
  fi
  if command -v gh &>/dev/null; then
    local token
    token="$(gh auth token 2>/dev/null || true)"
    if [[ -n "$token" ]]; then
      GH_TOKEN_VALUE="$token"
      log_info "Retrieved GH_TOKEN from GitHub CLI."
      return 0
    fi
  fi
  log_warn "GH_TOKEN is not set. Continuing without authentication."
}

# opencode の設定ファイルがホストに無い場合は空ファイルを作成する
# (README の「空ファイルとして作成してください」に相当するフォールバック)
ensure_opencode_host_config() {
  local share_dir="$HOME/.local/share/opencode"
  local config_dir="$HOME/.config/opencode"
  mkdir -p "$share_dir" "$config_dir"
  local f
  for f in \
    "$share_dir/auth.json" \
    "$config_dir/oh-my-opencode.json" \
    "$config_dir/opencode.json" \
    "$config_dir/tui.json"; do
    if [[ ! -f "$f" ]]; then
      log_warn "Created empty file: $f"
      log_warn "Run 'opencode auth login' on the host if you need authenticated models."
      touch "$f"
    fi
  done
}

# コンテナのデフォルト DNS (ゲートウェイ 192.168.64.1 経由) は、ホストの上流 DNS が
# IPv6 のみの環境では名前解決に失敗する。ホストの IPv4 DNS サーバーを検出して引き継ぐ。
resolve_dns_servers() {
  DNS_SERVERS=()
  if [[ -n "${AC_DNS_SERVERS:-}" ]]; then
    # shellcheck disable=SC2206
    DNS_SERVERS=(${AC_DNS_SERVERS})
    log_info "Using DNS servers from AC_DNS_SERVERS: ${DNS_SERVERS[*]}"
    return 0
  fi
  local ns
  while IFS= read -r ns; do
    DNS_SERVERS+=("$ns")
  done < <(scutil --dns 2>/dev/null \
    | sed -nE 's/.*nameserver\[[0-9]+\] : ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+).*/\1/p' \
    | awk '!seen[$0]++')
  if [[ "${#DNS_SERVERS[@]}" -gt 0 ]]; then
    log_info "Detected host IPv4 DNS servers: ${DNS_SERVERS[*]}"
  else
    log_warn "No IPv4 DNS servers found on the host. Falling back to the container default DNS."
  fi
}

# ---------------------------------------------------------------------------
# イメージ・ボリューム
# ---------------------------------------------------------------------------

build_image() {
  log_info "Building image $IMAGE_TAG from .devcontainer/Dockerfile ..."
  container build -t "$IMAGE_TAG" -f "$WORKSPACE_PATH/.devcontainer/Dockerfile" "$WORKSPACE_PATH"
}

ensure_image() {
  if [[ "$FORCE_BUILD" -eq 1 ]]; then
    build_image
  elif ! container image inspect "$IMAGE_TAG" &>/dev/null; then
    log_info "Image $IMAGE_TAG not found."
    build_image
  else
    log_info "Image $IMAGE_TAG already exists. Use --build to rebuild."
  fi
}

ensure_volumes() {
  VOLUME_NAMES=(
    "${CONTAINER_NAME}-bun-cache"
    "${CONTAINER_NAME}-uv-cache"
    "${CONTAINER_NAME}-node-modules"
    "${CONTAINER_NAME}-venv"
  )
  local vol
  for vol in "${VOLUME_NAMES[@]}"; do
    if ! container volume inspect "$vol" &>/dev/null; then
      log_info "Creating volume: $vol"
      container volume create "$vol" >/dev/null
    fi
  done
}

# ---------------------------------------------------------------------------
# コンテナ操作
# ---------------------------------------------------------------------------

container_exists() {
  container inspect "$CONTAINER_NAME" &>/dev/null
}

container_running() {
  container inspect "$CONTAINER_NAME" 2>/dev/null | grep -q '"state"[[:space:]]*:[[:space:]]*"running"'
}

# 既存コンテナが別のワークスペースパスで作成されていないか検査する
# (リポジトリ移動などでマウント元が変わった場合は作り直す)
container_workspace_matches() {
  # inspect の JSON は \/ エスケープされるため除去してから比較する
  container inspect "$CONTAINER_NAME" 2>/dev/null | tr -d '\\' | grep -qF "\"$WORKSPACE_PATH\""
}

create_container() {
  # devcontainer.json の mounts / remoteEnv / docker-compose.yml の volumes を再現する
  local args=(
    run -d --name "$CONTAINER_NAME" --init
    -c "$AC_CPUS" -m "$AC_MEMORY"
    -u node -w /workspace
    -e "UV_LINK_MODE=copy"
    -e "MAIN_REPO_PATH=/workspaces/$REPO_NAME"
    -e "WORKTREES_PATH=/workspaces/$REPO_NAME.worktrees"
    -v "$WORKSPACE_PATH:/workspace"
    -v "$MAIN_REPO_DIR:/workspaces/$REPO_NAME"
    -v "$(dirname "$WORKSPACE_PATH"):/workspaces/$REPO_NAME.worktrees"
    -v "$WORKSPACE_PATH/.devcontainer/.git-container:/workspace/.git"
    -v "$WORKSPACE_PATH/.devcontainer/.gitdir-container:/workspaces/$REPO_NAME/.git/worktrees/$WORKSPACE_NAME/gitdir"
    -v "$HOME/.local/share/opencode:/host-config/opencode/share:ro"
    -v "$HOME/.config/opencode:/host-config/opencode/config:ro"
    -v "${VOLUME_NAMES[0]}:/home/node/.bun/install/cache"
    -v "${VOLUME_NAMES[1]}:/home/node/.cache/uv"
    -v "${VOLUME_NAMES[2]}:/workspace/node_modules"
    -v "${VOLUME_NAMES[3]}:/workspace/.venv"
  )
  if [[ -n "$GH_TOKEN_VALUE" ]]; then
    args+=(-e "GH_TOKEN=$GH_TOKEN_VALUE")
  fi
  if [[ -f "$HOME/.gitconfig" ]]; then
    args+=(-v "$HOME/.gitconfig:/host-config/.gitconfig:ro")
  fi
  local ns
  for ns in ${DNS_SERVERS[@]+"${DNS_SERVERS[@]}"}; do
    args+=(--dns "$ns")
  done
  local spec
  for spec in ${AC_PORTS:-}; do
    args+=(-p "$spec")
  done
  args+=("$IMAGE_TAG" sleep infinity)

  log_info "Creating container: $CONTAINER_NAME (cpus=$AC_CPUS, memory=$AC_MEMORY)"
  container "${args[@]}" >/dev/null
}

# ---------------------------------------------------------------------------
# ライフサイクル (Dev Container の postCreateCommand / postStartCommand 相当)
# ---------------------------------------------------------------------------

exec_in_container() {
  local tty_flags=()
  if [[ -t 0 && -t 1 ]]; then
    tty_flags=(-it)
  fi
  local env_flags=()
  if [[ -n "${GH_TOKEN_VALUE:-}" ]]; then
    env_flags=(-e "GH_TOKEN=$GH_TOKEN_VALUE")
  fi
  container exec "${tty_flags[@]}" "${env_flags[@]}" -u node -w /workspace "$CONTAINER_NAME" "$@"
}

run_setup_scripts() {
  if [[ "${AC_NO_SETUP:-0}" == "1" ]]; then
    log_info "Skipping setup scripts (AC_NO_SETUP=1)."
    return 0
  fi
  log_info "Running setup scripts (auto-setup.sh, post-start.sh)..."
  exec_in_container bash -lc "bash /workspace/.devcontainer/auto-setup.sh && bash /workspace/.devcontainer/post-start.sh"
}

run_check_mounts() {
  # セットアップ完了後の状態検証として実行する (失敗しても環境は使えるので致命的エラーにはしない)
  exec_in_container bash /workspace/.devcontainer/check-mounts.sh || true
}

# ---------------------------------------------------------------------------
# DNS / アクセス情報
# ---------------------------------------------------------------------------

ensure_dns_domain() {
  [[ -z "${AC_DNS_DOMAIN:-}" ]] && return 0
  if container system dns list 2>/dev/null | grep -q "$AC_DNS_DOMAIN"; then
    return 0
  fi
  log_info "Creating DNS domain '$AC_DNS_DOMAIN' (requires sudo)..."
  sudo container system dns create "$AC_DNS_DOMAIN"
}

get_container_ip() {
  container inspect "$CONTAINER_NAME" 2>/dev/null \
    | grep '"ipv4Address"' | head -1 \
    | sed -E 's/.*"ipv4Address"[[:space:]]*:[[:space:]]*"([^"\/]+).*/\1/'
}

print_access_info() {
  local ip
  ip="$(get_container_ip || true)"
  echo "----------------------------------------"
  log_info "Container: $CONTAINER_NAME"
  if [[ -n "$ip" ]]; then
    log_info "IP address: $ip"
    log_info "Start your app bound to 0.0.0.0 and open http://${ip}:<port> from the host."
  fi
  if [[ -n "${AC_DNS_DOMAIN:-}" ]]; then
    log_info "DNS: http://${CONTAINER_NAME}.${AC_DNS_DOMAIN}:<port>"
  else
    log_info "Tip: set AC_DNS_DOMAIN (e.g. 'test') to access the container by name (requires sudo once)."
  fi
  echo "----------------------------------------"
}

# ---------------------------------------------------------------------------
# アクション
# ---------------------------------------------------------------------------

do_up() {
  preflight
  resolve_workspace
  run_host_initialize
  resolve_gh_token
  ensure_opencode_host_config
  ensure_dns_domain
  resolve_dns_servers
  ensure_image
  ensure_volumes

  if container_exists && ! container_workspace_matches; then
    log_warn "Existing container was created for a different workspace path. Recreating it..."
    do_down_quiet
  fi

  local created=0
  if ! container_exists; then
    create_container
    created=1
  elif ! container_running; then
    log_info "Starting existing container: $CONTAINER_NAME"
    container start "$CONTAINER_NAME" >/dev/null
  else
    log_info "Container already running: $CONTAINER_NAME"
  fi

  run_setup_scripts
  if [[ "$created" -eq 1 ]]; then
    run_check_mounts
  fi
  print_access_info
}

is_interactive_command() {
  case "$1" in
    bash|"bash -i"|"bash -l"|sh|"sh -i"|"sh -l"|zsh|"zsh -i"|"zsh -l")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

do_exec() {
  do_up
  if is_interactive_command "$COMMAND_TEXT"; then
    log_info "Entering interactive shell. Type 'exit' to return."
    exec_in_container bash -l
  else
    log_info "Running: $COMMAND_TEXT"
    exec_in_container bash -lc "$COMMAND_TEXT"
  fi
}

do_stop() {
  preflight
  resolve_workspace
  if container_exists && container_running; then
    container stop "$CONTAINER_NAME"
    log_info "Container stopped: $CONTAINER_NAME"
  else
    log_info "Container is not running: $CONTAINER_NAME"
  fi
}

do_down_quiet() {
  container_exists || return 0
  if container_running; then
    container stop "$CONTAINER_NAME" >/dev/null || true
  fi
  container rm "$CONTAINER_NAME" >/dev/null
}

do_down() {
  preflight
  resolve_workspace
  if container_exists; then
    do_down_quiet
    log_info "Container removed: $CONTAINER_NAME (volumes are kept; use 'clean' to remove them)"
  else
    log_info "Container does not exist: $CONTAINER_NAME"
  fi
}

do_clean() {
  preflight
  resolve_workspace
  if [[ "$ASSUME_YES" -ne 1 ]]; then
    echo "This removes the container '$CONTAINER_NAME' and its volumes (node_modules, .venv, caches)."
    read -r -p "Continue? [y/N] " answer
    case "$answer" in
      y|Y|yes|YES) ;;
      *) log_info "Aborted."; exit 0 ;;
    esac
  fi
  do_down_quiet
  local vol
  for vol in \
    "${CONTAINER_NAME}-bun-cache" \
    "${CONTAINER_NAME}-uv-cache" \
    "${CONTAINER_NAME}-node-modules" \
    "${CONTAINER_NAME}-venv"; do
    if container volume inspect "$vol" &>/dev/null; then
      container volume rm "$vol" >/dev/null
      log_info "Volume removed: $vol"
    fi
  done
  log_info "Clean complete. Next 'exec' will recreate the environment from scratch."
}

do_status() {
  preflight
  resolve_workspace
  if ! container_exists; then
    log_info "Container does not exist: $CONTAINER_NAME"
    exit 0
  fi
  local state ip
  if container_running; then state="running"; else state="stopped"; fi
  ip="$(get_container_ip || true)"
  echo "----------------------------------------"
  echo "Container : $CONTAINER_NAME"
  echo "Image     : $IMAGE_TAG"
  echo "State     : $state"
  echo "IP        : ${ip:-N/A}"
  echo "Workspace : $WORKSPACE_PATH"
  echo "Volumes   :"
  local vol
  for vol in \
    "${CONTAINER_NAME}-bun-cache" \
    "${CONTAINER_NAME}-uv-cache" \
    "${CONTAINER_NAME}-node-modules" \
    "${CONTAINER_NAME}-venv"; do
    if container volume inspect "$vol" &>/dev/null; then
      echo "  - $vol"
    fi
  done
  echo "----------------------------------------"
}

do_ip() {
  QUIET=1
  preflight
  resolve_workspace
  if ! container_exists || ! container_running; then
    log_error "Container is not running: $CONTAINER_NAME"
    exit 1
  fi
  get_container_ip
}

# ---------------------------------------------------------------------------
# 引数パース & ディスパッチ
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    up|exec|stop|down|clean|build|status|ip)
      ACTION="$1"
      shift
      ;;
    -WorkspacePath)
      if [[ -z "${2:-}" ]]; then
        log_error "-WorkspacePath requires a value."
        exit 1
      fi
      WORKSPACE_PATH="$2"
      shift 2
      ;;
    -Command)
      if [[ -z "${2:-}" ]]; then
        log_error "-Command requires a value."
        exit 1
      fi
      COMMAND_TEXT="$2"
      shift 2
      ;;
    --build)
      FORCE_BUILD=1
      shift
      ;;
    -y|--yes)
      ASSUME_YES=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      log_error "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

case "$ACTION" in
  up)     do_up ;;
  exec)   do_exec ;;
  stop)   do_stop ;;
  down)   do_down ;;
  clean)  do_clean ;;
  status) do_status ;;
  ip)     do_ip ;;
  build)
    preflight
    resolve_workspace
    FORCE_BUILD=1
    ensure_image
    ;;
esac
