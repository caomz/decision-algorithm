"use strict";

// 审核指令金样：chat 模式的提示词字节不变（仍等于 1.4.1 的输出），
// review 与 challenge 两种模式在固定 material/ids 下生成 P 的 sha256 写死。
// 改指令或分区结构都会在这里红掉；重钉清单只认哈希，不认措辞。

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { buildPrompt, validateReview } = require("../scripts/review.js");

const MATERIAL = JSON.stringify({ facts: [{ id: "F1", text: "golden material one" }, { id: "F2", text: "golden material two" }] }, null, 2) + "\n";
const IDS = ["F1", "F2"];
const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");

// chat 模式的金样（1.4.1 时的字节）。
const CHAT_SHA256 = "9c742e40c7a99a189d6d81943e7acf38328dd70f19dc6f357f4f8e8961b0f07d";
const REVIEW_SHA256 = "bde83773b6896da9066c71a3a6d26560564686d26b94814c049de369efd634ba";
const CHALLENGE_SHA256 = "b3223faeed43685784d928a919b96798b5411d61afb61a02e3b93fbbfde7c1ca";

test("chat mode prompt bytes are unchanged from 1.4.1", () => {
  assert.equal(sha256(buildPrompt(MATERIAL, "chat", null)), CHAT_SHA256);
});

test("review mode prompt including the example is pinned", () => {
  assert.equal(sha256(buildPrompt(MATERIAL, "review", IDS)), REVIEW_SHA256);
});

test("challenge mode prompt including the example is pinned", () => {
  assert.equal(sha256(buildPrompt(MATERIAL, "challenge", IDS)), CHALLENGE_SHA256);
});

test("the 1.5.0 instruction keeps the mode openers and the coverage summary contract", () => {
  const review = buildPrompt(MATERIAL, "review", IDS);
  const challenge = buildPrompt(MATERIAL, "challenge", IDS);
  assert.ok(review.startsWith(review.slice(0, review.indexOf("Assess only the supplied material"))));
  assert.ok(review.includes("Independently review the material. Assess only the supplied material"));
  assert.ok(challenge.includes("Challenge assumptions, failure modes and boundaries. Assess only the supplied material"));
  for (const prompt of [review, challenge]) {
    assert.ok(prompt.includes('Begin summary with "Checked: <aspects checked, or none>; Not checkable: <aspects not checkable, or none>."'));
    assert.ok(prompt.includes("REVIEW_SCHEMA\n"));
    assert.ok(prompt.includes("EVIDENCE_IDS\n"));
    assert.ok(prompt.includes("MATERIAL_JSON\n"));
    const example = prompt.split("REVIEW_EXAMPLE")[1].split("\n")[1];
    assert.deepEqual(validateReview(example, IDS).review.findings[0].evidence_refs, ["F1"]);
  }
});

test("a coverage-summary reply still validates against review-v1", () => {
  const { review, review_gate } = validateReview(JSON.stringify({
    version: 1,
    summary: "Checked: none; Not checkable: all.\nNo goal was supplied.",
    findings: [],
  }), IDS);
  assert.equal(review_gate, "PASS");
  assert.equal(review.summary.split("\n")[0], "Checked: none; Not checkable: all.");
});
