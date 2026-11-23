#!/bin/zsh
# Finder starts Terminal with a different PATH than many interactive shells.
export PATH="${PATH:+$PATH:}$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
if ! command -v node >/dev/null 2>&1; then
  print -u2 "需要 Node.js。请在已安装 Node.js 的终端运行这个文件。"
  exit 2
fi
exec node "${0:A:h}/scripts/mac-review.js" "$@"
