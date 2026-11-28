#!/usr/bin/env bash
# CI-only: no test command runs unless the new namespace has only loopback.
set -euo pipefail
[[ $# -gt 0 ]]
runner=$(id -un)
sandbox=$(mktemp -d)
trap 'rm -rf -- "$sandbox"' EXIT
mkdir -p "$sandbox"/{home,tmp,config,cache,data}
sudo unshare --net -- bash -euc '
  ip link set lo up
  [[ $(ip -o link show | wc -l) -eq 1 ]]
  [[ $(ip -o link show) == *": lo:"* ]]
  [[ -z $(ip -4 route show default) && -z $(ip -6 route show default) ]]
  printf "Isolation: loopback is the sole network interface; no default IPv4/IPv6 route.\n"
  ip -o link show
  runner=$1; toolpath=$2; root=$3; shift 3
  exec runuser -u "$runner" -- env -i PATH="$toolpath" HOME="$root/home" USERPROFILE="$root/home" XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache" XDG_DATA_HOME="$root/data" TMPDIR="$root/tmp" TMP="$root/tmp" TEMP="$root/tmp" CI=true LANG=C.UTF-8 "$@"
' bash "$runner" "$PATH" "$sandbox" "$@"
