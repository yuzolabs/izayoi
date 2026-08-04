#!/bin/bash

YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

check_mount() {
  local host_path="$1"
  local container_path="$2"
  local filename=$(basename "$container_path")

  if [ -d "$container_path" ]; then
    echo "${YELLOW}⚠ Warning: $container_path is a directory (expected file)${NC}"
    echo "   Host file does not exist: $host_path"

    if [ -z "$(ls -A "$container_path" 2>/dev/null)" ]; then
      echo "   Removing empty directory..."
      rm -rf "$container_path"
      if [ $? -eq 0 ]; then
        echo "   ${GREEN}✓ Empty directory removed${NC}"
      else
        echo "   ${YELLOW}✗ Failed to remove directory${NC}"
      fi
    else
      echo "   ${YELLOW}✗ Directory is not empty, cannot remove${NC}"
    fi

    echo "   Please create the file on host: $host_path"
    echo ""
    return 1
  elif [ ! -f "$container_path" ]; then
    echo "${YELLOW}⚠ Warning: $container_path not found${NC}"
    echo "   Expected host file: $host_path"
    echo ""
    return 1
  else
    echo "${GREEN}✓ $filename mounted successfully${NC}"
    return 0
  fi
}

echo "========================================"
echo "Checking mounted configuration files..."
echo "========================================"
echo ""

FAILED=0

check_mount "${HOME}/.local/share/opencode/auth.json" "/home/node/.local/share/opencode/auth.json" || FAILED=$((FAILED + 1))
check_mount "${HOME}/.config/opencode/oh-my-opencode.json" "/home/node/.config/opencode/oh-my-opencode.json" || FAILED=$((FAILED + 1))
check_mount "${HOME}/.config/opencode/opencode.json" "/home/node/.config/opencode/opencode.json" || FAILED=$((FAILED + 1))
check_mount "${HOME}/.config/opencode/tui.json" "/home/node/.config/opencode/tui.json" || FAILED=$((FAILED + 1))

echo "========================================"

if [ $FAILED -gt 0 ]; then
  echo ""
  echo "${YELLOW}$FAILED file(s) not mounted correctly.${NC}"
  echo "To fix this, run the following on your host machine:"
  echo ""
  echo "  opencode auth login"
  echo ""
  echo "Or create empty files if you don't need authentication:"
  echo ""
  echo "  mkdir -p ~/.local/share/opencode ~/.config/opencode"
  echo "  touch ~/.local/share/opencode/auth.json"
  echo "  touch ~/.config/opencode/oh-my-opencode.json"
  echo "  touch ~/.config/opencode/opencode.json"
  echo "  touch ~/.config/opencode/tui.json"
  echo ""
fi

echo "Done."
