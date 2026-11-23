"use strict";

// Loaded by the two executable stubs in the isolated test PATH. Their only
// outputs are local attempt records and the existing fake CLI event formats.
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

exports.main = async function (side, directory) {
  if (side === "zcode" && process.argv.includes("--version")) {
    return require("./fake-zcode-cli.cjs").run();
  }
  const scenario = JSON.parse(fs.readFileSync(path.join(directory, "scenario.json"), "utf8"));
  fs.appendFileSync(path.join(directory, side + ".attempts"), JSON.stringify({ pid: process.pid }) + "\n");
  if (scenario[side] === "hang") {
    setTimeout(() => { process.exitCode = 1; }, 30000);
    return;
  }
  if (scenario[side] === "empty") return;
  const archive = path.resolve(directory, "../run");
  if (scenario[side] === "reserve-stderr") {
    fs.writeFileSync(path.join(archive, side + "-stderr.log"), "reserved by fixture\n", { flag: "wx" });
  }
  if (scenario[side] === "wait-for-zcode-stdout") {
    const stdout = path.join(archive, "zcode-stdout.json");
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(stdout)) {
      if (Date.now() >= deadline) throw new Error("ZCode stdout was not archived in time");
      await delay(20);
    }
  }
  if (side === "zcode") return require("./fake-zcode-cli.cjs").run();

  const findings = scenario.mmx === "fail" ? [{
    kind: "confirmed_defect", severity: "P1", title: "Fixture defect",
    evidence_refs: ["F1"], condition: "F1 has the marker", impact: "test FAIL vote",
    recommendation: "remove marker",
  }] : [];
  process.env.MMX_FAKE_TEXT = JSON.stringify({ version: 1,
    summary: "Checked: F1; Not checkable: none.", findings });
  process.env.MMX_FAKE_STOP = scenario.mmx === "truncate" ? "max_tokens" : "end_turn";
  process.env.MMX_FAKE_DUMP = path.join(directory, "mmx-delivery.json");
  require("./mmx");
};
