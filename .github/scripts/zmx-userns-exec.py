#!/usr/bin/env python3
"""Run local Linux fixtures in an already-created, loopback-only namespace.

Usage (from a checkout, with a NEW private state directory):
  unshare --user --map-root-user --net -- python3 \
    .github/scripts/zmx-userns-exec.py /absolute/new/state node --test ...

This is an alternative for development hosts without sudo. CI retains its
existing sudo/network-namespace launcher. Failure to create/verify isolation
must stop execution; this helper never falls back to the host network.
"""

import errno
import fcntl
import json
import os
from pathlib import Path
import socket
import struct
import sys


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: zmx-userns-exec.py NEW_STATE_DIR COMMAND [ARG...]")
    if sys.platform != "linux" or os.geteuid() != 0:
        raise SystemExit("run under unshare --user --map-root-user --net")
    interfaces = [
        line.split(":", 1)[0].strip()
        for line in Path("/proc/net/dev").read_text().splitlines()[2:]
        if ":" in line
    ]
    if interfaces != ["lo"]:
        raise SystemExit("refusing tests: namespace must contain only lo")
    # ioctl works on hosts that prohibit AF_NETLINK used by ip(8).
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as control:
        fcntl.ioctl(control.fileno(), 0x8914, struct.pack("16sH14s", b"lo", 1, b""))
    routes = Path("/proc/net/route").read_text().splitlines()[1:]
    if any(line.split()[1] == "00000000" for line in routes if line.split()):
        raise SystemExit("refusing tests: IPv4 default route exists")
    for line in Path("/proc/net/ipv6_route").read_text().splitlines():
        fields = line.split()
        if fields[0] == "0" * 32 and fields[1] == "00" and fields[-1] != "lo":
            raise SystemExit("refusing tests: IPv6 default route exists")
    # Numeric documentation address: failure must be in the kernel, not DNS
    # or a proxy. No route means no outgoing packet from this namespace.
    with socket.socket() as probe:
        probe.settimeout(0.5)
        try:
            probe.connect(("192.0.2.1", 9))
        except OSError as exc:
            if exc.errno not in (errno.ENETUNREACH, errno.EHOSTUNREACH):
                raise
        else:
            raise SystemExit("refusing tests: external network is reachable")
    root = Path(sys.argv[1]).absolute()
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    for child in ("home", "tmp", "config", "cache", "data"):
        (root / child).mkdir(mode=0o700)
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(root / "home"),
        "USERPROFILE": str(root / "home"),
        "XDG_CONFIG_HOME": str(root / "config"),
        "XDG_CACHE_HOME": str(root / "cache"),
        "XDG_DATA_HOME": str(root / "data"),
        "TMPDIR": str(root / "tmp"),
        "TMP": str(root / "tmp"),
        "TEMP": str(root / "tmp"),
        "CI": "true",
        "LANG": "C.UTF-8",
    }
    print(json.dumps({
        "isolation": "Linux user/network namespace",
        "interfaces": interfaces,
        "external_probe": "kernel_unreachable",
        "environment": "allowlist with fresh home",
        "command": sys.argv[2:],
    }), flush=True)
    os.execvpe(sys.argv[2], sys.argv[2:], env)


if __name__ == "__main__":
    main()
