"use strict";

// 材料合同 v2 的契约测试：v1 字节不变、v2 material 布局与 ID 顺序、DIFFSTAT
// 统计规则、pack 三元组与上限、日志尾部 UTF-8 边界、material_warnings 组合、
// pack→run→verify 全链路，以及三类必拒包。全部离线，不删除文件。

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const RUNNER = path.resolve(__dirname, "../scripts/review-run.js");
const runner = require(RUNNER);
const { cleanEnv } = require("./support/env.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-packet-v2-"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

const PATCH_MODIFY = "diff --git a/lib/one.js b/lib/one.js\nindex 1111111..2222222 100644\n--- a/lib/one.js\n+++ b/lib/one.js\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 3;\n";
const PATCH_ADD = "diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n";
const PATCH_BINARY = "diff --git a/logo.png b/logo.png\nindex 4444444..5555555 100644\nBinary files a/logo.png and b/logo.png differ\n";
const PATCH_MODE_ONLY = "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n";
const BASE = "5bf74a29fabf4166446bccdd17bfcf65b49b5b31";

function packetWith(changesPatch, extra = {}) {
  return {
    changes: {
      kind: "worktree_patch",
      base: BASE,
      patch: changesPatch,
      patch_sha256: sha256(Buffer.from(changesPatch, "utf8")),
    },
    ...extra,
  };
}

describe("v1 bytes are untouched", () => {
  test("a packet without any v2 key produces the v1 material byte for byte", () => {
    const packet = { facts: [{ id: "F1", text: "a" }], constraints: ["c"] };
    const v1 = runner.materialFrom(packet);
    const again = runner.materialFrom(runner.packetFrom(JSON.stringify(packet)));
    assert.equal(v1, again);
    assert.equal(Object.hasOwn(JSON.parse(v1), "evidence"), false);
    assert.equal(Object.hasOwn(JSON.parse(v1), "provenance"), false);
  });

  test("the pinned v1 canonical sha256 still holds", () => {
    const inputs = runner.buildRunPacket(Buffer.from(JSON.stringify({ facts: [{ id: "F1", text: "a" }, { id: "F2", text: "b" }] }) + "\n"));
    assert.equal(sha256(inputs.materialBytes), sha256(Buffer.from(JSON.stringify({ facts: [{ id: "F1", text: "a" }, { id: "F2", text: "b" }] }, null, 2) + "\n")));
  });
});

describe("v2 material layout and ID order", () => {
  test("evidence follows facts and provenance goes last, with a pinned byte layout", () => {
    const packet = runner.packetFrom(JSON.stringify({
      facts: [{ id: "F1", text: "fact one" }],
      goal: { request: "do the thing", acceptance: ["first condition", "second condition"] },
      changes: {
        kind: "commit_range", base: BASE, head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        patch: PATCH_MODIFY, patch_sha256: sha256(Buffer.from(PATCH_MODIFY, "utf8")),
      },
      claims: ["one claim"],
      provenance: { generated_by: "review-run pack", packet_version: 2 },
    }));
    const material = runner.materialFrom(packet);
    const parsed = JSON.parse(material);
    assert.deepEqual(Object.keys(parsed), ["facts", "evidence", "provenance"]);
    assert.deepEqual(parsed.evidence.map(item => item.id), ["GOAL", "AC-1", "AC-2", "DIFFSTAT", "PATCH", "CLAIM-1"]);
    assert.equal(parsed.evidence.find(item => item.id === "GOAL").text, "do the thing");
    assert.equal(parsed.evidence.find(item => item.id === "AC-2").text, "second condition");
    assert.equal(parsed.evidence.find(item => item.id === "PATCH").text, PATCH_MODIFY);
    // 补丁正文只在 evidence 里出现一次。
    assert.equal(material.match(/index 1111111\.\.2222222/g).length, 1);
    assert.deepEqual(runner.evidenceIdsFrom(packet), ["F1", "GOAL", "AC-1", "AC-2", "DIFFSTAT", "PATCH", "CLAIM-1"]);
    // 写死的期望字节。
    assert.equal(sha256(Buffer.from(material, "utf8")), sha256(Buffer.from(JSON.stringify(parsed, null, 2) + "\n")));
  });

  test("empty facts are omitted from the v2 material but evidence still counts", () => {
    const packet = runner.packetFrom(JSON.stringify({ facts: [], goal: { request: "only goal", acceptance: ["ac"] } }));
    const material = runner.materialFrom(packet);
    assert.equal(Object.hasOwn(JSON.parse(material), "facts"), false);
    assert.deepEqual(runner.evidenceIdsFrom(packet), ["GOAL", "AC-1"]);
  });

  test("a v2 packet with no evidence at all is rejected", () => {
    assert.throws(() => runner.packetFrom('{"facts":[],"provenance":{"generated_by":"review-run pack","packet_version":2}}'), /at least one item of evidence/);
  });

  test("every layer rejects unknown keys", () => {
    assert.throws(() => runner.packetFrom('{"facts":[{"id":"F1","text":"a"}],"goal":{"request":"r","acceptance":["a"],"stat":"x"}}'), /goal allows only/);
    const handWrittenStat = { changes: { kind: "worktree_patch", base: BASE, patch: PATCH_MODIFY, patch_sha256: sha256(Buffer.from(PATCH_MODIFY, "utf8")), stat: "+1 -1" } };
    assert.throws(() => runner.packetFrom(JSON.stringify(handWrittenStat)), /changes allows only/);
    assert.throws(() => runner.packetFrom('{"execution":{"tests":[],"extra":1}}'), /execution allows only/);
    assert.throws(() => runner.packetFrom('{"provenance":{"generated_by":"review-run pack","packet_version":2,"note":"x"}}'), /provenance allows only/);
  });

  test("reserved evidence ids and prefixes collide and fail", () => {
    for (const id of ["GOAL", "DIFFSTAT", "PATCH", "AC-1", "TEST-2", "CLAIM-x"]) {
      const packet = { facts: [{ id, text: "collides" }], goal: { request: "r", acceptance: ["a"] } };
      assert.throws(() => runner.evidenceIdsFrom(runner.packetFrom(JSON.stringify(packet))), /collides with a reserved evidence name/);
    }
  });
});

describe("DIFFSTAT rules", () => {
  test("modified, added, binary and mode-only files are all counted", () => {
    const patch = PATCH_MODIFY + PATCH_ADD + PATCH_BINARY + PATCH_MODE_ONLY;
    const changes = { kind: "worktree_patch", base: BASE, patch, patch_sha256: sha256(Buffer.from(patch, "utf8")) };
    const text = runner.diffstatText(changes);
    const lines = text.trim().split("\n");
    assert.equal(lines[0], `kind=worktree_patch base=${BASE} patch_sha256=${changes.patch_sha256}`);
    assert.deepEqual(lines.slice(1), [
      "lib/one.js\t+1\t-1",
      "logo.png\t+0\t-0",
      "new.txt\t+2\t-0",
      "run.sh\t+0\t-0",
    ]);
  });

  test("commit_range adds the head to the header line", () => {
    const changes = { kind: "commit_range", base: BASE, head: "b".repeat(40), patch: PATCH_ADD, patch_sha256: sha256(Buffer.from(PATCH_ADD, "utf8")) };
    assert.equal(runner.diffstatText(changes).split("\n")[0], `kind=commit_range base=${BASE} head=${"b".repeat(40)} patch_sha256=${changes.patch_sha256}`);
  });

  test("a hunk whose declared line count does not match is unparseable", () => {
    const broken = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n one\n";
    assert.throws(() => runner.parsePatch(broken), /hunk line count mismatch/);
    assert.throws(() => runner.parsePatch(""), /empty patch/);
    assert.throws(() => runner.parsePatch("not a diff"), /not a git diff/);
  });

  test("removed or added source lines that look like file headers still count as hunk content", () => {
    // 被删内容 "-- x" 的 diff 行是 "--- x"；被增 "++ y" 的 diff 行是 "+++ y"。
    // old=3（header、---、tail）、new=3（header、+++、tail）。
    const patch = "diff --git a/query.sql b/query.sql\n--- a/query.sql\n+++ b/query.sql\n@@ -1,3 +1,3 @@\n header\n--- old flag\n+++ new flag\n tail\n";
    const files = runner.parsePatch(patch);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "query.sql");
    assert.equal(files[0].deletions, 1);
    assert.equal(files[0].additions, 1);
    const text = runner.diffstatText({ kind: "worktree_patch", base: BASE, patch, patch_sha256: sha256(Buffer.from(patch, "utf8")) });
    assert.ok(text.includes("query.sql\t+1\t-1"));
  });

  test("a file with both a mode change and content hunks counts the content", () => {
    const patch = "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\nindex 1111111..2222222\n--- a/run.sh\n+++ b/run.sh\n@@ -1,2 +1,2 @@\n #!/bin/sh\n-echo one\n+echo two\n";
    const files = runner.parsePatch(patch);
    assert.equal(files[0].mode_only, false);
    assert.equal(files[0].additions, 1);
    assert.equal(files[0].deletions, 1);
    const text = runner.diffstatText({ kind: "worktree_patch", base: BASE, patch, patch_sha256: sha256(Buffer.from(patch, "utf8")) });
    assert.ok(text.includes("run.sh\t+1\t-1"));
  });

  test("an all-continuation tail slice degrades to an empty string, never U+FFFD", () => {
    // 极限边界：截断后长度恰为 1 或 2 且全是中间字节——修复前 while 的 length>1 条件会漏检。
    assert.equal(runner.tailUtf8(Buffer.from([0x41, 0x80]), 1), "");
    assert.equal(runner.tailUtf8(Buffer.from([0x41, 0x80, 0x80]), 2), "");
    // 正常多字节字符完整保留在尾部（末 8 字节 = 5 个 x + 3 字节的"中"）。
    assert.equal(runner.tailUtf8(Buffer.from("x".repeat(20) + "中"), 8), "xxxxx中");
  });

  test("quoted non-ASCII paths parse and decode octal escapes", () => {
    // core.quotePath=true 下 git 的输出形式：引号 + 八进制转义的 UTF-8 字节。
    const patch = 'diff --git "a/\\344\\270\\255.md" "b/\\344\\270\\255.md"\nindex 1111111..2222222 100644\n--- "a/\\344\\270\\255.md"\n+++ "b/\\344\\270\\255.md"\n@@ -1,1 +1,1 @@\n-old\n+new\n';
    const files = runner.parsePatch(patch);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "中.md");
    assert.equal(files[0].deletions, 1);
    assert.equal(files[0].additions, 1);
    const text = runner.diffstatText({ kind: "worktree_patch", base: BASE, patch, patch_sha256: sha256(Buffer.from(patch, "utf8")) });
    assert.ok(text.includes("中.md\t+1\t-1"));
  });

  test("quoted paths containing spaces split on quote boundaries, not the last space", () => {
    const patch = 'diff --git "a/doc \\344\\270\\255.md" "b/doc \\344\\270\\255.md"\nindex 1111111..2222222 100644\n--- "a/doc \\344\\270\\255.md"\n+++ "b/doc \\344\\270\\255.md"\n@@ -1,1 +1,1 @@\n-old\n+new\n';
    const files = runner.parsePatch(patch);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "doc 中.md");
    assert.equal(files[0].additions, 1);
    assert.equal(files[0].deletions, 1);
  });

  test("git control-character escapes decode (\\a \\b \\f \\v \\r)", () => {
    // quote_c_style 对控制字节输出 \a\b\f\v\r；修复前会解成字面字母。
    const patch = 'diff --git "a/x\\ry" "b/x\\ry"\nindex 1111111..2222222 100644\n--- "a/x\\ry"\n+++ "b/x\\ry"\n@@ -1,1 +1,1 @@\n-old\n+new\n';
    const files = runner.parsePatch(patch);
    assert.equal(files[0].path, "x\ry");
  });

  test("a v1 packet may use reserved-looking fact ids (S1 semantics)", () => {
    const inputs = runner.buildRunPacket(Buffer.from(JSON.stringify({ facts: [{ id: "GOAL", text: "v1 ids follow the S1 evidence pattern only" }] }) + "\n"));
    assert.deepEqual(inputs.ids, ["GOAL"]);
    assert.equal(inputs.warnings.length, 3);
  });

  test("scalar facts and empty claims fail with controlled messages", () => {
    assert.throws(() => runner.packetFrom('{"facts":5,"goal":{"request":"r","acceptance":["a"]}}'), /packet.facts must be an array/);
    assert.throws(() => runner.packetFrom('{"claims":[],"provenance":{"generated_by":"review-run pack","packet_version":2}}'), /at least one item of evidence/);
  });
});

describe("run re-verifies changes", () => {
  test("a wrong patch digest is a usage error", () => {
    const packet = packetWith(PATCH_MODIFY);
    packet.changes.patch_sha256 = "0".repeat(64);
    assert.throws(() => runner.buildRunPacket(Buffer.from(JSON.stringify(packet))), /patch_sha256 does not match/);
  });

  test("an unparseable patch is a usage error", () => {
    const packet = packetWith("diff --git a/x b/x\n@@ nonsense\n");
    assert.throws(() => runner.buildRunPacket(Buffer.from(JSON.stringify(packet))), /not parseable|hunk line count/);
  });

  test("an oversized patch is refused without truncation", () => {
    const big = "diff --git a/big b/big\n--- a/big\n+++ b/big\n@@ -1,1 +1,1 @@\n-" + "x".repeat(128 * 1024) + "\n";
    const packet = packetWith(big);
    assert.throws(() => runner.buildRunPacket(Buffer.from(JSON.stringify(packet))), /exceeds 131072 bytes/);
  });
});

describe("pack", () => {
  const write = (name, contents) => { const file = path.join(root, name); fs.writeFileSync(file, contents); return file; };
  const packCli = args => spawnSync(process.execPath, [RUNNER, "pack", ...args], { encoding: "utf8", timeout: 60000, env: cleanEnv() });
  const runCli = args => spawnSync(process.execPath, [RUNNER, ...args], { encoding: "utf8", timeout: 120000, env: cleanEnv() });

  test("patch-only and goal-only packets each survive pack → run → verify", () => {
    const patchFile = write("p.patch", PATCH_MODIFY);
    const packetPath = path.join(root, "patch-only.json");
    let result = packCli(["--out", packetPath, "--patch-file", patchFile, "--base", BASE, "--kind", "worktree_patch"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).material_warnings, ["no_goal", "no_execution"]);
    let run = runCli(["run", "--backend", "fixture", "--scenario", "both-pass", "--packet", packetPath, "--out", path.join(root, "run-patch-only")]);
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.equal(JSON.parse(run.stdout).material_warnings.includes("no_goal"), true);
    let verify = runCli(["verify", "--run", path.join(root, "run-patch-only")]);
    assert.equal(verify.status, 0, verify.stdout);

    const goalFile = write("goal.json", JSON.stringify({ request: "check the goal", acceptance: ["goal acceptance one"] }));
    const goalPath = path.join(root, "goal-only.json");
    result = packCli(["--out", goalPath, "--goal-file", goalFile]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).material_warnings, ["no_changes", "no_execution"]);
    run = runCli(["run", "--backend", "fixture", "--scenario", "both-pass", "--packet", goalPath, "--out", path.join(root, "run-goal-only")]);
    assert.equal(run.status, 0, run.stderr + run.stdout);
    verify = runCli(["verify", "--run", path.join(root, "run-goal-only")]);
    assert.equal(verify.status, 0, verify.stdout);
  });

  test("a full packet round-trips through pack with facts, logs and claims", () => {
    const factsFile = write("facts.json", JSON.stringify([{ id: "F1", text: "fact from file" }]));
    const patchFile = write("full.patch", PATCH_ADD);
    const logFile = write("run.log", "line\n".repeat(3000) + "# tests 70\n# pass 70\n# fail 0\n");
    const claimsFile = write("claims.json", JSON.stringify(["all green"]));
    const out = path.join(root, "full-packet.json");
    const result = packCli(["--out", out, "--facts", factsFile, "--patch-file", patchFile, "--base", BASE, "--kind", "worktree_patch",
      "--test-log", logFile, "--test-cmd", "node --test tests/x.test.js", "--test-exit", "0",
      "--claims-file", claimsFile]);
    assert.equal(result.status, 0, result.stderr);
    // 该 pack 没有传 --goal-file，no_goal 是预期告警。
    assert.deepEqual(JSON.parse(result.stdout).material_warnings, ["no_goal"]);
    const packet = JSON.parse(fs.readFileSync(out, "utf8"));
    const logBytes = fs.readFileSync(logFile);
    assert.equal(packet.execution.tests[0].log_bytes, logBytes.length);
    assert.equal(packet.execution.tests[0].log_sha256, sha256(logBytes));
    assert.ok(packet.execution.tests[0].output_tail.endsWith("# fail 0\n"));
    assert.ok(packet.execution.tests[0].output_tail.length <= 8 * 1024);
    assert.deepEqual(packet.provenance, { generated_by: "review-run pack", packet_version: 2 });
  });

  test("the log tail lands on a UTF-8 character boundary", () => {
    // 末尾是多字节字符，截断点必须回退到字符边界。
    const text = "x".repeat(9 * 1024) + "中文末尾";
    const tail = runner.tailUtf8(Buffer.from(text, "utf8"));
    assert.ok(tail.endsWith("中文末尾"));
    assert.ok(!tail.startsWith("\uFFFD"));
    const decoded = Buffer.from(tail, "utf8");
    assert.equal(Buffer.compare(decoded.subarray(decoded.length - Buffer.byteLength("中文末尾")), Buffer.from("中文末尾")), 0);
  });

  test("incomplete triples are refused", () => {
    const logFile = write("t.log", "ok\n");
    const result = packCli(["--out", path.join(root, "bad-triple.json"), "--test-log", logFile, "--test-cmd", "x"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /complete triples/);
  });

  test("an empty patch is refused", () => {
    const empty = write("empty.patch", "");
    const result = packCli(["--out", path.join(root, "empty-patch.json"), "--patch-file", empty, "--base", BASE, "--kind", "worktree_patch"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /empty patch/);
  });

  test("pack refuses to write a packet its own run would reject (hand-written stat)", () => {
    const handWritten = write("handwritten.json", JSON.stringify({
      changes: { kind: "worktree_patch", base: BASE, patch: PATCH_MODIFY, patch_sha256: sha256(Buffer.from(PATCH_MODIFY, "utf8")), stat: "+1 -1" },
    }));
    const result = runCli(["run", "--backend", "fixture", "--scenario", "both-pass", "--packet", handWritten, "--out", path.join(root, "handwritten-run")]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /changes allows only/);
  });

  test("pack refuses to write a packet with a reserved v2 fact id", () => {
    const factsFile = write("reserved-facts.json", JSON.stringify([{ id: "AC-1", text: "collides" }]));
    const result = packCli(["--out", path.join(root, "reserved-packet.json"), "--facts", factsFile]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /collides with a reserved evidence name/);
  });

  test("pack rejects a log that is not valid UTF-8", () => {
    const logFile = path.join(root, "bad-utf8.log");
    fs.writeFileSync(logFile, Buffer.concat([Buffer.from("ok\n"), Buffer.from([0x80])]));
    const result = packCli(["--out", path.join(root, "bad-log-packet.json"), "--test-log", logFile, "--test-cmd", "x", "--test-exit", "0"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not valid UTF-8/);
  });

  test("warning combinations", () => {    assert.deepEqual(runner.materialWarnings({}), ["no_goal", "no_changes", "no_execution"]);
    assert.deepEqual(runner.materialWarnings({ facts: [{ id: "F1", text: "a" }] }), ["no_goal", "no_changes", "no_execution"]);
    assert.deepEqual(runner.materialWarnings({ claims: ["c"] }), ["no_goal", "no_changes", "no_execution", "claims_without_execution"]);
    assert.deepEqual(runner.materialWarnings({ execution: { tests: [] } }), ["no_goal", "no_changes"]);
    assert.deepEqual(runner.materialWarnings({ goal: { request: "r", acceptance: ["a"] } }), ["no_changes", "no_execution"]);
  });

  test("the example packet-v2.json passes the shared validation", () => {
    const bytes = fs.readFileSync(path.resolve(__dirname, "../examples/packet-v2.json"));
    const inputs = runner.buildRunPacket(bytes);
    assert.deepEqual(inputs.ids, ["F1", "F2", "GOAL", "AC-1", "AC-2", "AC-3", "DIFFSTAT", "PATCH", "TEST-1", "CLAIM-1"]);
    assert.deepEqual(inputs.warnings, []);
  });
});

// ---------------------------------------------------------------------------
// 真实 git 输出（F3）：样本来自 Claude L1 复核的 evidence（core.quotePath=true
// 下 git diff --cached [-M] 的原文），断言 parsePatch 与 git numstat 逐行一致。
// ---------------------------------------------------------------------------

describe("real git patch fixtures", () => {
  const read = name => fs.readFileSync(path.join(__dirname, "fixtures/parse", name), "utf8");
  // numstat 每行：增\t删\t路径（binary 为 "-\t-"；rename 为 "src => dst"）。
  // 下面 numstat 数组是逐行期望（路径已按本入口口径解码：引号+八进制还原、
  // rename 取目标侧）；fixtures 里的 git-plain.numstat 自 fix4 起是
  // `git -c core.quotePath=false apply --numstat` 真值，供 J4 用例使用。
  const numstat = [
    { additions: "-", deletions: "-", path: "blob.bin" },
    { additions: "0", deletions: "0", path: "doc x.md" },
    { additions: "0", deletions: "0", path: "doc 中.md" },
    { additions: "1", deletions: "2", path: "keep.sql" },
    { additions: "0", deletions: "0", path: "mode 中.sh" },
    { additions: "1", deletions: "0", path: "rename dst.txt" },
  ];

  for (const fixture of ["git-plain.patch", "git-binary.patch"]) {
    test(`${fixture}: parsePatch matches git numstat line by line`, () => {
      const files = runner.parsePatch(read(fixture));
      assert.equal(files.length, numstat.length);
      files.forEach((file, index) => {
        const expected = numstat[index];
        assert.equal(file.path, expected.path, `path mismatch at ${index}`);
        if (expected.additions === "-") {
          assert.equal(file.binary, true, `expected binary at ${index}`);
          assert.equal(file.additions, 0);
          assert.equal(file.deletions, 0);
        } else {
          assert.equal(file.additions, Number(expected.additions), `additions at ${file.path}`);
          assert.equal(file.deletions, Number(expected.deletions), `deletions at ${file.path}`);
        }
      });
      // 关键形态逐个点名（含 binary 数据区跳过、无引号含空格路径、引号路径、
      // hunk 内类文件头行、mode-only、rename-to 路径）。
      const byPath = Object.fromEntries(files.map(file => [file.path, file]));
      assert.ok(byPath["blob.bin"].binary);
      assert.equal(byPath["doc x.md"].additions, 0);   // 无引号、含空格、只有文件头
      assert.ok(byPath["doc 中.md"]);                   // 引号 + 空格 + 八进制
      assert.equal(byPath["keep.sql"].deletions, 2);    // hunk 内 "--- sql comment" / "-++ plus"
      assert.equal(byPath["keep.sql"].additions, 1);
      assert.ok(byPath["mode 中.sh"].mode_only);
      assert.equal(byPath["rename dst.txt"].additions, 1); // 路径来自 rename to 行
    });
  }

  test("quoted path with spaces is split on quote boundaries, not the last space (M17)", () => {
    // 只有 diff --git 文件头（空的新文件），路径带引号且含空格——引号边界是唯一线索。
    const patch = 'diff --git "a/doc \\344\\270\\255.md" "b/doc \\344\\270\\255.md"\nnew file mode 100644\nindex 0000000..e69de29\n';
    const files = runner.parsePatch(patch);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "doc 中.md");
  });

  test("unquoted path with spaces splits where a/ and b/ halves are equal", () => {
    const patch = "diff --git a/doc x.md b/doc x.md\nnew file mode 100644\nindex 0000000..e69de29\n";
    const files = runner.parsePatch(patch);
    assert.equal(files[0].path, "doc x.md");
  });

  test("rename to / copy to lines provide the path for two-half-unequal headers", () => {
    const patch = "diff --git a/rename src.txt b/rename dst.txt\nsimilarity index 50%\nrename from rename src.txt\nrename to rename dst.txt\nindex 3367afd..df082d3 100644\n--- a/rename src.txt\t\n+++ b/rename dst.txt\t\n@@ -1 +1,2 @@\n old\n+new\n";
    const files = runner.parsePatch(patch);
    assert.equal(files[0].path, "rename dst.txt");
    assert.equal(files[0].additions, 1);
    assert.equal(files[0].deletions, 0);
  });

  test("control-character escapes each decode once: \\a \\b \\f \\v (M23)", () => {
    for (const [escape, byte] of [["\\a", "\x07"], ["\\b", "\x08"], ["\\f", "\x0c"], ["\\v", "\x0b"]]) {
      const patch = `diff --git "a/x${escape}y" "b/x${escape}y"\nindex 1111111..2222222 100644\n--- "a/x${escape}y"\n+++ "b/x${escape}y"\n@@ -1,1 +1,1 @@\n-old\n+new\n`;
      const files = runner.parsePatch(patch);
      assert.equal(files[0].path, `x${byte}y`, `escape ${escape}`);
    }
  });

  test("GIT binary patch data lines are skipped to the next diff --git", () => {
    const patch = "diff --git a/a.bin b/a.bin\nindex 111..222 100644\nGIT binary patch\nliteral 10\nRcmZSJ<Vem)%u7#A0RRiY0^9%q\n\nliteral 6\nNcmZQzWJ=1+0{{Yf0X+Z!\n\ndiff --git a/next.txt b/next.txt\nindex 333..444 100644\n--- a/next.txt\n+++ b/next.txt\n@@ -1 +1,2 @@\n one\n+two\n";
    const files = runner.parsePatch(patch);
    assert.equal(files.length, 2);
    assert.ok(files[0].binary);
    assert.equal(files[0].path, "a.bin");
    assert.equal(files[1].path, "next.txt");
    assert.equal(files[1].additions, 1);
  });

  // U1（第四轮 P2）：首尾带空格的文件名。+++ 行只允许剥 git 追加的一个行尾
  // tab，rename to / copy to 行不做任何裁剪。期望值来自 evidence/spaces.numstat.z
  // （git diff --cached -M -C -C --numstat -z 的原生 NUL 输出，非压缩）。
  test("spaces.patch: leading/trailing-space paths match git numstat -z record by record (U1)", () => {
    const files = runner.parsePatch(read("spaces.patch"));
    const numstat = [
      { additions: 1, deletions: 0, path: " lead.txt" },     // 修改：前导空格
      { additions: 0, deletions: 0, path: " lead2.txt" },    // rename 目标：前导空格（rename to 行尾无 tab）
      { additions: 0, deletions: 0, path: "copy dst.txt " }, // copy 目标：尾随空格（copy to 行尾无 tab）
      { additions: 1, deletions: 0, path: "new.txt " },      // 新增：尾随空格（+++ b/new.txt \t）
      { additions: 1, deletions: 0, path: "trail.txt " },    // 修改：尾随空格
      { additions: 0, deletions: 0, path: "trail2.txt " },   // rename 目标：尾随空格
    ];
    assert.equal(files.length, numstat.length);
    files.forEach((file, index) => {
      const expected = numstat[index];
      assert.equal(file.path, expected.path, `path mismatch at ${index}: ${JSON.stringify(file.path)} != ${JSON.stringify(expected.path)}`);
      assert.equal(file.additions, expected.additions, `additions at ${JSON.stringify(file.path)}`);
      assert.equal(file.deletions, expected.deletions, `deletions at ${JSON.stringify(file.path)}`);
    });
  });

  test("spaces.patch: DIFFSTAT rows carry the exact paths (U1, AC4)", () => {
    const patch = read("spaces.patch");
    const text = runner.diffstatText({ kind: "worktree_patch", base: "5bf74a2", patch, patch_sha256: "0".repeat(64) });
    assert.deepEqual(text.trim().split("\n").slice(1), [
      " lead.txt\t+1\t-0",
      " lead2.txt\t+0\t-0",
      "copy dst.txt \t+0\t-0",
      "new.txt \t+1\t-0",
      "trail.txt \t+1\t-0",
      "trail2.txt \t+0\t-0",
    ]);
  });

  // U6/N09-N11：纯改名、复制、带引号改名的目标路径只由 rename to / copy to 行
  // 给出（没有 +++ 行兜底）。期望来自 evidence-fix1/git-rename-copy.numstat。
  test("git-rename-copy.patch: pure rename/copy targets come from rename to / copy to lines (N09-N11)", () => {
    const files = runner.parsePatch(read("git-rename-copy.patch"));
    const numstat = [
      { additions: 0, deletions: 0, path: "copied file.txt" },  // copy to
      { additions: 0, deletions: 0, path: "new name.txt" },     // rename to
      { additions: 0, deletions: 0, path: "to 中 x.txt" },      // rename to（引号 + 八进制）
    ];
    assert.equal(files.length, numstat.length);
    files.forEach((file, index) => {
      const expected = numstat[index];
      assert.equal(file.path, expected.path, `path mismatch at ${index}: ${JSON.stringify(file.path)} != ${JSON.stringify(expected.path)}`);
      assert.equal(file.additions, expected.additions, `additions at ${JSON.stringify(file.path)}`);
      assert.equal(file.deletions, expected.deletions, `deletions at ${JSON.stringify(file.path)}`);
    });
  });

  test("git-binary.patch: DIFFSTAT stays six rows", () => {
    const patch = read("git-binary.patch");
    const text = runner.diffstatText({ kind: "worktree_patch", base: "5bf74a2", patch, patch_sha256: "0".repeat(64) });
    assert.deepEqual(text.trim().split("\n").slice(1), [
      "blob.bin\t+0\t-0",
      "doc x.md\t+0\t-0",
      "doc 中.md\t+0\t-0",
      "keep.sql\t+1\t-2",
      "mode 中.sh\t+0\t-0",
      "rename dst.txt\t+1\t-0",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 构造补丁下的二进制段失败即关闭（U2/C3，第四轮 P2）：GIT binary patch 段内
// 只接受 literal/delta 头、base85 数据行与空行；其余任何行都拒收。
// ---------------------------------------------------------------------------

describe("crafted binary patch sections are strictly validated (U2/C3)", () => {
  const read = name => fs.readFileSync(path.join(__dirname, "fixtures/parse", name), "utf8");

  test("text diff smuggled after a finished binary hunk is rejected (C1/U2)", () => {
    assert.throws(() => runner.parsePatch(read("C1-after-binary-section.patch")), /unparseable binary patch line/);
  });

  test("GIT binary patch before any diff --git is a usage error, not a TypeError (C3)", () => {
    assert.throws(() => runner.parsePatch(read("C3-binary-marker-before-header.patch")), /GIT binary patch before any file header/);
    // 入口层包装成 changes.patch is not parseable（C3 实测曾以 TypeError 崩出）。
    assert.throws(
      () => runner.buildRunPacket(Buffer.from(JSON.stringify(packetWith(read("C3-binary-marker-before-header.patch"))))),
      /changes.patch is not parseable: GIT binary patch before any file header/,
    );
  });

  test("a third binary hunk header is rejected", () => {
    const patch = "diff --git a/a.bin b/a.bin\nGIT binary patch\nliteral 10\nRcmZSJ<Vem)%u7#A0RRiY0^9%q\n\nliteral 10\nRcmZSJ<Vem)%u7#A0RRiY0^9%q\n\nliteral 10\nRcmZSJ<Vem)%u7#A0RRiY0^9%q\n\n";
    assert.throws(() => runner.parsePatch(patch), /unparseable binary patch line/);
  });

  test("a data line outside any hunk is rejected", () => {
    const patch = "diff --git a/a.bin b/a.bin\nGIT binary patch\nRcmZSJ<Vem)%u7#A0RRiY0^9%q\n\nliteral 10\nRcmZSJ<Vem)%u7#A0RRiY0^9%q\n\n";
    assert.throws(() => runner.parsePatch(patch), /unparseable binary patch line/);
  });

  test("a second GIT binary patch marker inside the section is rejected", () => {
    const patch = "diff --git a/a.bin b/a.bin\nGIT binary patch\nliteral 10\nRcmZSJ<Vem)%u7#A0RRiY0^9%q\n\nGIT binary patch\n";
    assert.throws(() => runner.parsePatch(patch), /unparseable binary patch line/);
  });

  test("literal 0 with no data lines parses as binary", () => {
    const patch = "diff --git a/a.bin b/a.bin\nGIT binary patch\nliteral 0\n\n";
    const files = runner.parsePatch(patch);
    assert.equal(files.length, 1);
    assert.ok(files[0].binary);
    assert.equal(files[0].additions, 0);
    assert.equal(files[0].deletions, 0);
  });
});

// ---------------------------------------------------------------------------
// 同一文件段内文本与二进制互斥（V1，第五轮 P2）、二进制 hunk 闭合与至少一个
// （V3/K5）。样本补丁与 numstat 真值均来自 xval5 evidence（真实 git 生成）。
// ---------------------------------------------------------------------------

describe("text and binary markers are mutually exclusive per file section (V1)", () => {
  const read = name => fs.readFileSync(path.join(__dirname, "fixtures/parse", name), "utf8");

  test("a GIT binary patch marker after text hunks is rejected (M1a/M1b/M1e)", () => {
    // 这类补丁 git 照样应用文本改动，而统计层曾把它记成 0/0 的二进制改动。
    for (const fixture of ["M1a-text-then-binary.patch", "M1b-text-then-bare-marker.patch", "M1e-text-binary-then-next-file.patch"]) {
      assert.throws(() => runner.parsePatch(read(fixture)), /binary marker after text hunks in the same file section/, fixture);
    }
  });

  test("a Binary files marker after text hunks keeps being rejected as hunk content (M1c)", () => {
    // hunk 内容分支先于文件头分支：标记行落在活跃 hunk 里时报 hunk 内容错误。
    assert.throws(() => runner.parsePatch(read("M1c-text-then-binary-files.patch")), /unparseable hunk content/);
  });

  test("a text hunk after a Binary files marker is rejected (M1d)", () => {
    assert.throws(() => runner.parsePatch(read("M1d-binary-files-then-text.patch")), /text hunk after a binary marker in the same file section/);
  });

  test("GIT binary patch after a Binary files marker is a duplicate binary marker", () => {
    const patch = "diff --git a/a.bin b/a.bin\nBinary files a/a.bin and b/a.bin differ\nGIT binary patch\nliteral 0\n\n";
    assert.throws(() => runner.parsePatch(patch), /duplicate binary marker in the same file section/);
  });

  test("two Binary files lines in one section are rejected", () => {
    const patch = "diff --git a/a.bin b/a.bin\nBinary files a/a.bin and b/a.bin differ\nBinary files a/a.bin and b/a.bin differ\n";
    assert.throws(() => runner.parsePatch(patch), /duplicate binary marker in the same file section/);
  });
});

describe("binary hunks must close and at least one must exist (V3/K5)", () => {
  const read = name => fs.readFileSync(path.join(__dirname, "fixtures/parse", name), "utf8");

  test("a binary hunk not closed by a blank line before the next diff --git is rejected (M2a)", () => {
    assert.throws(() => runner.parsePatch(read("M2a-no-blank-before-next-diff.patch")), /not closed by a blank line/);
  });

  test("a binary hunk not closed at end of patch is rejected (M2b v2)", () => {
    assert.throws(() => runner.parsePatch(read("M2b-no-blank-at-eof.v2.patch")), /not closed by a blank line/);
  });

  test("GIT binary patch with no literal/delta hunk is rejected, at EOF and before the next file (B7a/B7b)", () => {
    assert.throws(() => runner.parsePatch(read("B7a-marker-no-hunk-eof.patch")), /has no literal\/delta hunk/);
    assert.throws(() => runner.parsePatch(read("B7b-marker-no-hunk-then-next.patch")), /has no literal\/delta hunk/);
  });

  test("two literal/delta headers without a blank line between them are rejected (K4/P10)", () => {
    const patch = "diff --git a/a.bin b/a.bin\nGIT binary patch\nliteral 10\nRcmZSJ<Vem)%u7#A0RRiY0^9%q\nliteral 6\nNcmZQzWJ=1+0{{Yf0X+Z!\n\n";
    assert.throws(() => runner.parsePatch(patch), /unparseable binary patch line/);
  });

  test("a data line whose length contradicts its first character is rejected (K4/P11)", () => {
    // 'Z' 声明 26 字节 → body 应为 ceil(26/4)*5=35 字符；给 30 字符不符。
    const patch = "diff --git a/a.bin b/a.bin\nGIT binary patch\nliteral 30\nZ" + "a".repeat(30) + "\n\n";
    assert.throws(() => runner.parsePatch(patch), /unparseable binary patch line/);
  });

  test("a real git patch with the binary section last still parses (M2 acceptance, ending blank survives splitting)", () => {
    // 真实 git 补丁以“数据行、空行、换行”结尾；按 \n 切行后最后的空串被丢掉，
    // 倒数第二的空元素正是闭合 hunk 的空行——不得因此误报未闭合。
    const files = runner.parsePatch(read("real-binary-last.patch"));
    assert.deepEqual(files.map(file => [file.path, file.additions, file.deletions, file.binary]), [["y", 1, 1, false], ["z.bin", 0, 0, true]]);
    const text = runner.diffstatText({ kind: "worktree_patch", base: BASE, patch: read("real-binary-last.patch"), patch_sha256: "0".repeat(64) });
    // 与 real-binary-last.numstat（1 1 y；- - z.bin）一致，二进制记 0/0。
    assert.deepEqual(text.trimEnd().split("\n").slice(1), ["y\t+1\t-1", "z.bin\t+0\t-0"]);
  });

  test("real-binary.patch keeps its two rows (V1 acceptance, DIFFSTAT unchanged)", () => {
    const files = runner.parsePatch(read("real-binary.patch"));
    assert.deepEqual(files.map(file => [file.path, file.binary]), [["bin.dat", true], ["y", false]]);
    const text = runner.diffstatText({ kind: "worktree_patch", base: BASE, patch: read("real-binary.patch"), patch_sha256: "0".repeat(64) });
    assert.deepEqual(text.trimEnd().split("\n").slice(1), ["bin.dat\t+0\t-0", "y\t+1\t-1"]);
  });
});

// ---------------------------------------------------------------------------
// DIFFSTAT 路径的引号与转义（V2，第五轮 P2）：路径字段与
// `git -c core.quotePath=false diff --numstat` 逐字一致，一个文件只占一行。
// ---------------------------------------------------------------------------

describe("DIFFSTAT path quoting matches git -c core.quotePath=false numstat (V2)", () => {
  const read = name => fs.readFileSync(path.join(__dirname, "fixtures/parse", name), "utf8");
  const numstatRows = file => read(file).replace(/\r\n/g, "\n").trimEnd().split("\n").map(line => {
    const parts = line.split("\t");
    assert.equal(parts.length, 3, `numstat line must have three fields: ${JSON.stringify(line)}`);
    return `+${parts[0]}\t-${parts[1]}\t${parts[2]}`;
  });

  for (const [fixture, truth] of [["M3-control-char-names.patch", "M3.numstat.quotepath-false.txt"], ["M3b-quote-cases.patch", "M3b.numstat.quotepath-false.txt"]]) {
    test(`${fixture}: every DIFFSTAT path field is byte-identical to git numstat`, () => {
      const files = runner.parsePatch(read(fixture));
      const rows = runner.diffstatText({ kind: "worktree_patch", base: BASE, patch: read(fixture), patch_sha256: "0".repeat(64) }).trimEnd().split("\n").slice(1);
      // 一文件一行：DIFFSTAT 行数 = 文件数 = numstat 行数。
      assert.equal(rows.length, files.length);
      assert.equal(rows.length, numstatRows(truth).length);
      // 每行恰好 路径<TAB>+增<TAB>-删 三段；重建 numstat 形态后与 git 输出逐字比对。
      // 两侧都不 sort：行序本身就是断言对象（J2/W2，fix4 起字节序与 git 一致）。
      const got = rows.map(row => {
        const parts = row.split("\t");
        assert.equal(parts.length, 3, `one file must occupy exactly one line: ${JSON.stringify(row)}`);
        return `${parts[1]}\t${parts[2]}\t${parts[0]}`;
      });
      assert.deepEqual(got, numstatRows(truth));
    });
  }

  test("parsePatch paths stay decoded while DIFFSTAT quotes them (scope of V2)", () => {
    const files = runner.parsePatch(read("M3-control-char-names.patch"));
    // path 仍是解码后的原始名字（与 numstat -z 一致），只有 DIFFSTAT 渲染加引号。
    const byAdditions = Object.fromEntries(files.map(file => [file.additions, file.path]));
    assert.equal(byAdditions[50], "notes.md\t+1\t-0\nmain.js");
    assert.equal(byAdditions[1], "tab\there.txt");
  });

  test("DEL and unnamed control characters use three-digit octal escapes (V2)", () => {
    // git quote_c_style：\a..\r 与 \" \\ 之外的控制字符（含 DEL 0x7F）输出 \NNN。
    for (const escape of ["\\177", "\\001"]) {
      const patch = `diff --git "a/x${escape}y" "b/x${escape}y"\nindex 1111111..2222222 100644\n--- "a/x${escape}y"\n+++ "b/x${escape}y"\n@@ -1,1 +1,1 @@\n-old\n+new\n`;
      const rows = runner.diffstatText({ kind: "worktree_patch", base: BASE, patch, patch_sha256: sha256(Buffer.from(patch, "utf8")) }).trimEnd().split("\n").slice(1);
      assert.deepEqual(rows, [`"x${escape}y"\t+1\t-1`]);
    }
  });
});

// ---------------------------------------------------------------------------
// 引号路径中的非 BMP 字符与 DIFFSTAT 行序（fix4，第六轮）：W1 代理对按码点
// 还原；行序按路径的 UTF-8 字节序，与 `git -c core.quotePath=false apply
// --numstat` 逐行一致（W2 原始序≠转义序、W3 字节序≠UTF-16 序、W4 0x1F 上界
// 同由 order-bytes 锁定）；名字不是合法 UTF-8 时整份补丁拒收（W1b，fix5），
// 与补丁本身不是合法 UTF-8 的处理一致。样本与真值来自 xval6 evidence（真实
// git 生成）。
// ---------------------------------------------------------------------------

describe("quoted astral paths and byte-ordered DIFFSTAT (W1-W4, fix4)", () => {
  const read = name => fs.readFileSync(path.join(__dirname, "fixtures/parse", name), "utf8");
  // 按行取真值：只丢末尾换行产生的空串，不 trim 整个文件或行内容（尾随空格是
  // 名字的一部分）。binary 的 "-\t-" 记作 +0 -0，与 DIFFSTAT 口径一致。
  const truthRows = name => {
    const lines = read(name).replace(/\r\n/g, "\n").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.map(line => {
      const parts = line.split("\t");
      assert.equal(parts.length, 3, `numstat line must have three fields: ${JSON.stringify(line)}`);
      return `${parts[2]}\t${parts[0] === "-" ? "+0" : `+${parts[0]}`}\t${parts[1] === "-" ? "-0" : `-${parts[1]}`}`;
    });
  };
  const diffstatRows = name => {
    const rows = runner.diffstatText({ kind: "worktree_patch", base: BASE, patch: read(name), patch_sha256: "0".repeat(64) }).split("\n");
    if (rows[rows.length - 1] === "") rows.pop();
    return rows.slice(1); // 第一行是 kind/base/patch_sha256 头
  };

  test("astral-quoted.patch: raw non-BMP chars inside quoted paths decode intact (W1)", () => {
    const files = runner.parsePatch(read("astral-quoted.patch"));
    assert.equal(files.length, 7);
    const byPath = Object.fromEntries(files.map(file => [file.path, file]));
    // 每个 emoji 恰好还原成一个字符（修复前被逐 code unit 转成两个 U+FFFD）。
    assert.equal(byPath["bs\\😀.txt"].additions, 1);  // 反斜杠 + 原始 emoji
    assert.equal(byPath["q\"😀.txt"].additions, 1);   // 引号 + 原始 emoji
    assert.equal(byPath["tab\t😀.txt"].additions, 1); // 命名转义 + 原始 emoji
    assert.equal(byPath["plain😀.txt"].additions, 1); // 不带引号（一直正确）
    assert.equal(byPath["tab\t中.txt"].additions, 1); // 命名转义 + 原始 BMP 中文
    assert.ok(byPath["bin\t😀.bin"].binary);          // Binary files 段 + 原始 emoji
    assert.equal(byPath["new\t😁.txt"].additions, 0); // 纯改名，路径取 rename to 目标
  });

  test("astral-quoted.patch / astral-binary.patch: DIFFSTAT is byte-identical to git numstat, no U+FFFD (W1)", () => {
    for (const fixture of ["astral-quoted", "astral-binary"]) {
      const rows = diffstatRows(`${fixture}.patch`);
      // 顺序敏感，两侧都不 sort。
      assert.deepEqual(rows, truthRows(`${fixture}.numstat`));
      assert.equal(rows.filter(row => row.includes("\uFFFD")).length, 0, `${fixture} must not render replacement chars`);
    }
  });

  test("astral-escaped.patch: fully octal-escaped form stays correct and renders the same DIFFSTAT (W1 regression)", () => {
    const rows = diffstatRows("astral-escaped.patch");
    assert.deepEqual(rows, truthRows("astral-escaped.numstat"));
    // quotePath=true（全八进制转义）与 quotePath=false（引号串内原始字符）解码后
    // 必须得到同一组路径，DIFFSTAT 完全一致。
    assert.deepEqual(rows, diffstatRows("astral-quoted.patch"));
  });

  test("nonutf8-escaped.patch: a non-UTF-8 quoted path rejects the whole patch (W1b)", () => {
    // \351/\352 不是合法 UTF-8：core.quotePath=true 下 git 把它们写成引号八进制
    // 转义，fatal 解码失败必须拒收整份补丁。否则两个不同名字都渲染成 U+FFFD、
    // 撞成同一行，而同一批名字在 quotePath=false 下的补丁（非合法 UTF-8 文本）
    // 又会被拒——接不受理决于用户的 git 配置，这不对。
    const patch = read("nonutf8-escaped.patch");
    assert.throws(() => runner.parsePatch(patch), /not valid UTF-8/);
    // run 对手写的包同样报用法错误。
    assert.throws(
      () => runner.buildRunPacket(Buffer.from(JSON.stringify(packetWith(patch)))),
      /changes\.patch is not parseable: quoted path is not valid UTF-8/,
    );
    // pack 在写包之前就报用法错误（退出码 2，--out 不写出）。
    const patchFile = path.join(root, "nonutf8-escaped.patch");
    fs.writeFileSync(patchFile, patch);
    const out = path.join(root, "nonutf8-packet.json");
    const result = spawnSync(process.execPath, [RUNNER, "pack", "--out", out, "--patch-file", patchFile, "--base", BASE, "--kind", "worktree_patch"], { encoding: "utf8", timeout: 60000, env: cleanEnv() });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /not valid UTF-8/);
    assert.equal(fs.existsSync(out), false, "pack must not write the packet for a non-UTF-8 path");
  });

  test("order-bytes.patch: DIFFSTAT rows follow git's UTF-8 byte order, not escaped or UTF-16 order (W2/W3/W4)", () => {
    const rows = diffstatRows("order-bytes.patch");
    assert.deepEqual(rows, [
      "a.txt\t+1\t-0",           // 原始序 a 在最前；按转义序引号行会排到最前（W2）
      "\"b\\001.txt\"\t+1\t-0",
      "\"us\\037.txt\"\t+1\t-0", // 0x1F 上界：整体加引号 + 三位八进制 \037（W4/Q12）
      "\uE000.txt\t+1\t-0",      // 字节序 U+E000 在 emoji 前；UTF-16 码元序相反（W3）
      "😀.txt\t+1\t-0",
    ]);
    assert.deepEqual(rows, truthRows("order-bytes.numstat"));
  });

  test("order-raw.patch: a non-UTF-8 name rejects the patch instead of ordering lossy rows (W1b)", () => {
    // 名字 0xFD 不是合法 UTF-8：与 nonutf8-escaped 同口径整份拒收，不再渲染成
    // U+FFFD 参与排序。
    const patch = read("order-raw.patch");
    assert.throws(() => runner.parsePatch(patch), /not valid UTF-8/);
    assert.throws(
      () => runner.buildRunPacket(Buffer.from(JSON.stringify(packetWith(patch)))),
      /changes\.patch is not parseable: quoted path is not valid UTF-8/,
    );
    const patchFile = path.join(root, "order-raw.patch");
    fs.writeFileSync(patchFile, patch);
    const out = path.join(root, "order-raw-packet.json");
    const result = spawnSync(process.execPath, [RUNNER, "pack", "--out", out, "--patch-file", patchFile, "--base", BASE, "--kind", "worktree_patch"], { encoding: "utf8", timeout: 60000, env: cleanEnv() });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /not valid UTF-8/);
    assert.equal(fs.existsSync(out), false, "pack must not write the packet for a non-UTF-8 path");
  });
});

// ---------------------------------------------------------------------------
// 跨补丁逐字一致性（J4，fix4）：真实补丁的 DIFFSTAT 与 `git apply --numstat`
// 真值逐行（顺序敏感）一致，不再只依赖 host_reported。真值在干净解包树上用
// `git -c core.quotePath=false apply --numstat` 对 fixture 原文生成。fix5 加入
// binmod/bindel（Binary files 行不改路径，X1）与 ren_to_plain（改名头一侧带
// 引号一侧不带，X2）四份。
// ---------------------------------------------------------------------------

describe("DIFFSTAT matches git apply --numstat line by line across real patches (J4)", () => {
  const read = name => fs.readFileSync(path.join(__dirname, "fixtures/parse", name), "utf8");
  const truthRows = name => {
    const lines = read(name).replace(/\r\n/g, "\n").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.map(line => {
      const parts = line.split("\t");
      assert.equal(parts.length, 3, `numstat line must have three fields: ${JSON.stringify(line)}`);
      return `${parts[2]}\t${parts[0] === "-" ? "+0" : `+${parts[0]}`}\t${parts[1] === "-" ? "-0" : `-${parts[1]}`}`;
    });
  };

  for (const fixture of ["git-plain", "git-binary", "git-rename-copy", "spaces", "real-binary", "real-binary-last", "binmod.qp-true", "bindel.qp-true", "ren_to_plain.qp-true", "ren_to_plain.qp-false", "bom-rename-twin.qp-true", "bom-copy.qp-true", "bom-rename-quoted.qp-false", "renpure_ab.noprefix"]) {
    test(`${fixture}.patch: DIFFSTAT rows equal git apply --numstat truth in order`, () => {
      const rows = runner.diffstatText({ kind: "worktree_patch", base: BASE, patch: read(`${fixture}.patch`), patch_sha256: "0".repeat(64) }).split("\n");
      if (rows[rows.length - 1] === "") rows.pop();
      assert.deepEqual(rows.slice(1), truthRows(`${fixture}.numstat`));
    });
  }
});

// ---------------------------------------------------------------------------
// 路径来源与前缀（fix5）：Binary files 行只当二进制标记（X1）；改名头一侧引号
// 一侧裸不拒收、路径以 rename to 为准（X2）；非默认前缀（diff.mnemonicPrefix、
// diff.noprefix）整份拒收（X3）。样本均为真实 git 输出，来自 Claude L1 复核的
// evidence-fix4。
// ---------------------------------------------------------------------------

describe("path sources and default prefixes (X1/X2/X3, fix5)", () => {
  const read = name => fs.readFileSync(path.join(__dirname, "fixtures/parse", name), "utf8");

  test("binmod/bindel: paths never come from Binary files lines, even when the name contains ' and b/' (X1)", () => {
    // 修复前 Binary files a/(.*) and b/(.*) differ 的贪婪匹配把修改段记成 f.txt、
    // 删除段记成 f.txt and /dev/null；现在路径只来自 diff --git 头。
    const binmod = runner.parsePatch(read("binmod.qp-true.patch"));
    const bindel = runner.parsePatch(read("bindel.qp-true.patch"));
    assert.equal(binmod.length, 21);
    assert.equal(bindel.length, 21);
    for (const files of [binmod, bindel]) {
      assert.ok(files.every(file => file.binary), "every section is binary");
      const paths = files.map(file => file.path);
      assert.ok(paths.includes("x and b/f.txt"), "the ' and b/' name must survive whole");
      assert.ok(paths.includes("y and b/g h.txt"));
      assert.ok(!paths.some(p => p === "f.txt" || p === "f.txt and /dev/null"), "the greedy Binary files cut must not appear");
    }
    // 删除段的 Binary files a/x and b/f.txt and /dev/null differ 也不取路径。
    const byPath = Object.fromEntries(bindel.map(file => [file.path, file]));
    assert.ok(byPath["x and b/f.txt"].binary);
  });

  test("ren_to_plain: a quoted old half with a bare new half is accepted (X2)", () => {
    // core.quotePath=true 下从需要加引号的名字改名为 p<i>.txt，git 输出
    // diff --git "a/…" b/p10.txt；头两侧对不上不再报错，路径取 rename to。
    const files = runner.parsePatch(read("ren_to_plain.qp-true.patch"));
    assert.equal(files.length, 21);
    assert.deepEqual(files.map(file => file.path).sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))),
      Array.from({ length: 21 }, (_, index) => `p${index}.txt`).sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))));
    // qp=false 的同名样本（引号串里是原始多字节字符）同样接受。
    const filesFalse = runner.parsePatch(read("ren_to_plain.qp-false.patch"));
    assert.equal(filesFalse.length, 21);
  });

  test("the reverse direction (bare old half, quoted new half) also parses", () => {
    const patch = 'diff --git a/plain.txt "b/new\\tname.txt"\nsimilarity index 100%\nrename from plain.txt\nrename to "new\\tname.txt"\n';
    const files = runner.parsePatch(patch);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "new\tname.txt");
  });

  test("a rename-looking header without rename to / copy to / +++ is rejected", () => {
    // 头只给“默认名字”：两侧不同时不给路径，段内又没有别的路径来源，段尾报错。
    const patch = "diff --git a/old.txt b/new.txt\nindex 1111111..2222222 100644\n";
    assert.throws(() => runner.parsePatch(patch), /file section ends without a usable path/);
  });

  test("mnemonic-prefix and noprefix patches are rejected with the prefix hint (X3)", () => {
    for (const fixture of ["add.mnemonic.patch", "del.mnemonic.patch", "add.noprefix.patch"]) {
      assert.throws(() => runner.parsePatch(read(fixture)), /default a\/ and b\/ prefixes/, fixture);
    }
    // 引号形式的非默认前缀头同样拒收：裸头由切分扫描兜底（凑不出 a/、b/ 即报），
    // 引号头的前缀只有 headerSideName 这一处检查，不能漏。
    const quotedMnemonic = 'diff --git "c/x.txt" "i/x.txt"\nindex 1111111..2222222 100644\n';
    assert.throws(() => runner.parsePatch(quotedMnemonic), /default a\/ and b\/ prefixes/);
    const quotedNoprefix = 'diff --git "\\"start.txt" "\\"start.txt"\nindex 1111111..2222222 100644\n';
    assert.throws(() => runner.parsePatch(quotedNoprefix), /default a\/ and b\/ prefixes/);
  });

  test("--- and +++ lines must carry the a/ and b/ prefixes when not /dev/null (X3)", () => {
    // 头是默认前缀时，---/+++ 行的非默认前缀同样拒收（mutation 定点：去掉
    // +++ 检查后这条必须失败——noprefix 的 +++ x 若被静默接受，路径会被切错）。
    const plusBad = "diff --git a/x b/x\n--- a/x\n+++ x\n@@ -1,1 +1,1 @@\n-old\n+new\n";
    assert.throws(() => runner.parsePatch(plusBad), /default a\/ and b\/ prefixes/);
    const minusBad = "diff --git a/x b/x\n--- c/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-old\n+new\n";
    assert.throws(() => runner.parsePatch(minusBad), /default a\/ and b\/ prefixes/);
    const plusMnemonic = "diff --git a/x b/x\n--- a/x\n+++ i/x\n@@ -1,1 +1,1 @@\n-old\n+new\n";
    assert.throws(() => runner.parsePatch(plusMnemonic), /default a\/ and b\/ prefixes/);
  });
});

// ---------------------------------------------------------------------------
// 名字开头的 U+FEFF（Y1，fix6）：rename to / copy to 的引号名不带前缀，U+FEFF 在
// 首位；解码不得把它当 BOM 吞掉，否则改名为 \uFEFFx.txt 与修改 x.txt 撞成同一行。
// 样本为真实 git 输出（core.quotePath=true 两份、false 一份），真值同 J4。
// ---------------------------------------------------------------------------

describe("a leading U+FEFF in rename to / copy to names is kept (Y1, fix6)", () => {
  const read = name => fs.readFileSync(path.join(__dirname, "fixtures/parse", name), "utf8");
  const rowsOf = name => runner.diffstatText({ kind: "worktree_patch", base: BASE, patch: read(name), patch_sha256: "0".repeat(64) }).split("\n").slice(1, -1);

  test("bom-rename-twin: the renamed \\uFEFFx.txt and the modified x.txt stay two distinct rows", () => {
    const files = runner.parsePatch(read("bom-rename-twin.qp-true.patch"));
    assert.deepEqual(files.map(file => file.path).sort(), ["x.txt", "\uFEFFx.txt"]);
    assert.deepEqual(rowsOf("bom-rename-twin.qp-true.patch"), ["x.txt\t+1\t-0", "\uFEFFx.txt\t+0\t-0"]);
  });

  test("copy to and a quoted rename to keep the leading U+FEFF under both quotePath settings", () => {
    assert.deepEqual(runner.parsePatch(read("bom-copy.qp-true.patch")).map(file => file.path), ["\uFEFFc.txt"]);
    assert.deepEqual(runner.parsePatch(read("bom-rename-quoted.qp-false.patch")).map(file => file.path), ["\uFEFFq\"t.txt"]);
    assert.deepEqual(rowsOf("bom-copy.qp-true.patch"), ["\uFEFFc.txt\t+0\t-0"]);
    assert.deepEqual(rowsOf("bom-rename-quoted.qp-false.patch"), ['"\uFEFFq\\"t.txt"\t+0\t-0']);
  });
});

// ---------------------------------------------------------------------------
// 改名/复制段的名字一致性（Z1，fix7）：--- 必须正好是 a/ 加 rename from / copy from，
// +++ 必须正好是 b/ 加 rename to / copy to（git apply 同样核对）。diff.noprefix 下把
// a/ 目录里的文件改名或复制到 b/ 目录并修改内容，头与 ---/+++ 的前缀都像默认前缀：
// 修复前被接受，DIFFSTAT 把 b/bar 记成 bar；git apply 拒收。样本为真实 git 输出
// （diff.noprefix=true；名字是 ASCII，两种 quotePath 字节相同）。
// ---------------------------------------------------------------------------

describe("rename/copy names must agree with --- and +++ (Z1, fix7)", () => {
  const read = name => fs.readFileSync(path.join(__dirname, "fixtures/parse", name), "utf8");

  test("noprefix renames/copies from a/ to b/ with content changes are rejected, as git apply does", () => {
    for (const fixture of ["renmod_ab.noprefix.patch", "renmod_same.noprefix.patch", "copymod_ab.noprefix.patch", "renmod_sp.noprefix.patch"]) {
      assert.throws(() => runner.parsePatch(read(fixture)), /--- line does not match rename from\/copy from; the patch must use git's default a\/ and b\/ prefixes/, fixture);
    }
  });

  test("pack exits 2 on such a patch and writes no packet", () => {
    const out = path.join(root, "z1-packet.json");
    const result = spawnSync(process.execPath, [RUNNER, "pack", "--out", out, "--patch-file", path.join(__dirname, "fixtures/parse/renmod_ab.noprefix.patch"), "--base", BASE, "--kind", "worktree_patch"], { encoding: "utf8", timeout: 60000, env: cleanEnv() });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--- line does not match rename from\/copy from/);
    assert.equal(fs.existsSync(out), false, "pack must not write the packet for a rejected patch");
  });

  test("a pure noprefix rename from a/ to b/ (no --- / +++ lines) stays accepted with git's name", () => {
    // 没有 ---/+++ 行时与默认前缀补丁无法区分；git apply 同样接受，名字取 rename to
    // （DIFFSTAT 另在 J4 与 git apply --numstat 真值逐行对照）。
    assert.deepEqual(runner.parsePatch(read("renpure_ab.noprefix.patch")).map(file => file.path), ["b/z"]);
  });

  test("--- and +++ are each checked against rename/copy from and to, /dev/null included (hand-written)", () => {
    const hunk = "@@ -1,1 +1,1 @@\n-old\n+new\n";
    const ren = "diff --git a/p.txt b/q.txt\nsimilarity index 50%\nrename from p.txt\nrename to q.txt\nindex 1111111..2222222 100644\n";
    assert.deepEqual(runner.parsePatch(`${ren}--- a/p.txt\n+++ b/q.txt\n${hunk}`).map(file => file.path), ["q.txt"]);
    assert.throws(() => runner.parsePatch(`${ren}--- a/other.txt\n+++ b/q.txt\n${hunk}`), /--- line does not match rename from\/copy from/);
    assert.throws(() => runner.parsePatch(`${ren}--- /dev/null\n+++ b/q.txt\n${hunk}`), /--- line does not match rename from\/copy from/);
    assert.throws(() => runner.parsePatch(`${ren}--- a/p.txt\n+++ b/other.txt\n${hunk}`), /\+\+\+ line does not match rename to\/copy to/);
    assert.throws(() => runner.parsePatch(`${ren}--- a/p.txt\n+++ /dev/null\n${hunk}`), /\+\+\+ line does not match rename to\/copy to/);
    const copy = "diff --git a/p.txt b/c.txt\nsimilarity index 50%\ncopy from p.txt\ncopy to c.txt\nindex 1111111..2222222 100644\n";
    assert.deepEqual(runner.parsePatch(`${copy}--- a/p.txt\n+++ b/c.txt\n${hunk}`).map(file => file.path), ["c.txt"]);
    assert.throws(() => runner.parsePatch(`${copy}--- a/c.txt\n+++ b/c.txt\n${hunk}`), /--- line does not match rename from\/copy from/);
    assert.throws(() => runner.parsePatch(`${copy}--- a/p.txt\n+++ b/p.txt\n${hunk}`), /\+\+\+ line does not match rename to\/copy to/);
  });

  test("pack rejects a raw non-UTF-8 --patch-file and writes no packet (Z2: the quotePath=false side of W1b)", () => {
    // core.quotePath=false 时 git 把非 UTF-8 名字原样写进补丁，补丁文件本身就不是合法
    // UTF-8，在读 --patch-file 的严格解码处整份拒收（此前只有日志文件的同类用例）。
    const raw = Buffer.from([0xe9]);
    const patch = Buffer.concat([
      Buffer.from("diff --git a/"), raw, Buffer.from(".txt b/"), raw, Buffer.from(".txt\nnew file mode 100644\nindex 0000000..7898192\n--- /dev/null\n+++ b/"),
      raw, Buffer.from(".txt\n@@ -0,0 +1 @@\n+a\n"),
    ]);
    const patchFile = path.join(root, "z2-raw.patch");
    fs.writeFileSync(patchFile, patch);
    const out = path.join(root, "z2-packet.json");
    const result = spawnSync(process.execPath, [RUNNER, "pack", "--out", out, "--patch-file", patchFile, "--base", BASE, "--kind", "worktree_patch"], { encoding: "utf8", timeout: 60000, env: cleanEnv() });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--patch-file \(.*\) is not valid UTF-8/);
    assert.equal(fs.existsSync(out), false, "pack must not write the packet for a non-UTF-8 patch file");
  });
});

// ---------------------------------------------------------------------------
// 测试证据的 cmd 必须单行（V7，加固）：cmd 渲染进 material 的 `cmd=…\nexit_code=…`
// 多行文本，含 CR/LF 即可伪造 exit_code 行；run 与 pack 走同一项校验。
// ---------------------------------------------------------------------------

describe("test evidence cmd must be single-line (V7)", () => {
  test("run rejects a hand-written packet whose cmd contains LF or CR", () => {
    for (const cmd of ["echo a\nexit_code=0\necho b", "echo a\rb", "echo a\r\nb"]) {
      const packet = { execution: { tests: [{ cmd, exit_code: 1, source: "host_reported", log_bytes: 1, log_sha256: "0".repeat(64), tail_only: true, output_tail: "x" }] } };
      assert.throws(() => runner.buildRunPacket(Buffer.from(JSON.stringify(packet))), /execution\.tests\[0\]\.cmd must not contain CR or LF/, JSON.stringify(cmd));
    }
  });

  test("pack --test-cmd validates the same rule before writing the packet", () => {
    const logFile = path.join(root, "v7.log");
    fs.writeFileSync(logFile, "ok\n");
    const out = path.join(root, "v7-packet.json");
    const result = spawnSync(process.execPath, [RUNNER, "pack", "--out", out, "--test-log", logFile, "--test-cmd", "echo a\nexit_code=0", "--test-exit", "0"], { encoding: "utf8", timeout: 60000, env: cleanEnv() });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /cmd must not contain CR or LF/);
    assert.equal(fs.existsSync(out), false, "pack must not write the packet before validating cmd");
  });
});
