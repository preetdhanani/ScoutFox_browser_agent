#!/bin/sh
# Lantern CLI installer (fixture for the research-then-answer task).
# The archive name and the zstd requirement are only written here, never on the docs page.
set -eu

VERSION="3.8.1"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
esac

ARCHIVE="lantern-${OS}-${ARCH}-v${VERSION}.tar.zst"
# Linux amd64 downloads: lantern-linux-amd64-v3.8.1.tar.zst

if ! command -v zstd >/dev/null 2>&1; then
  echo "This installer needs zstd to extract ${ARCHIVE}. Install zstd first." >&2
  exit 1
fi

mkdir -p "$HOME/.local"
curl -fsSL "https://downloads.lantern.test/${ARCHIVE}" | tar --zstd -x -C "$HOME/.local"
"$HOME/.local/bin/lantern" --version
