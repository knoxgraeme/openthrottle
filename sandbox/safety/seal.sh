#!/usr/bin/env bash
# safety/seal.sh — best-effort immutability seal for a single file.
#
# Usage: seal.sh <file>
#
# Tries `chattr +i` (the ext2/3/4 immutable attribute — blocks writes even
# for root without first `chattr -i`). Many container filesystems (overlayfs
# without the right lowerdir support, some network/CI filesystems) don't
# support extended attributes and chattr fails with "Operation not
# permitted" or "Inappropriate ioctl for device"; in that case fall back to
# root-owned chmod 444, which is weaker (root can still chmod it back) but
# still stops the unprivileged `agent` user from editing it directly.
#
# Idempotent: safe to call again on an already-sealed file (e.g. on a
# resumed sandbox where the file was sealed on the first run).

set -euo pipefail

FILE="${1:?usage: seal.sh <file>}"

if [[ ! -e "$FILE" ]]; then
  echo "[seal] WARNING: ${FILE} does not exist, skipping" >&2
  exit 0
fi

if command -v lsattr >/dev/null 2>&1 && lsattr -d -- "$FILE" 2>/dev/null | awk '{print $1}' | grep -q 'i'; then
  echo "[seal] ${FILE} already immutable, skipping" >&2
  exit 0
fi

if chattr +i -- "$FILE" 2>/dev/null; then
  echo "[seal] ${FILE} sealed (chattr +i)" >&2
else
  chown root:root -- "$FILE" 2>/dev/null || true
  chmod 444 -- "$FILE"
  echo "[seal] WARNING: chattr +i unsupported on this filesystem — sealed ${FILE} via chmod 444 instead (weaker: root can still modify it)" >&2
fi
