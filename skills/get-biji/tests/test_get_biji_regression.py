"""pytest 入口：运行 get-biji 的 node:test 回归套件。

skill 的回归测试是 node:test 文件（仓库约定，见根 README 的验证命令）；
这里包装成 pytest 用例，让 ``pytest skills/get-biji/tests -q`` 这条验收命令
可直接运行，用例本身仍在 ``*.test.cjs`` 里。代理变量按验收约定先清掉——
宿主代理 env 会让 node 单测大面积假失败。
"""

import os
import pathlib
import shutil
import subprocess

import pytest

TESTS_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = TESTS_DIR.parents[2]
PROXY_VARS = (
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "NODE_USE_ENV_PROXY",
)


def test_get_biji_node_test_suite():
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not available")
    env = {k: v for k, v in os.environ.items() if k not in PROXY_VARS}
    proc = subprocess.run(
        [node, "--test", str(TESTS_DIR / "*.test.cjs")],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert proc.returncode == 0, "node --test failed:\n{}\n{}".format(proc.stdout, proc.stderr)
    assert "pass 0" not in proc.stdout, "node --test collected no tests:\n{}".format(proc.stdout)
