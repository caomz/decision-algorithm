"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

// zcode-runtime 0.17.1. Its reviewed provider transport uses Node fetch or,
// with an explicit proxy/CA, node:http(s).request. Re-audit changed bundles.
const ENTRY_SHA256 = "052b1bc504b7e47da297cdb0d13f1899baa804b675247d757f26b0560a97b540";
function digest(file) { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

function currentDispatcher() {
  return globalThis[Symbol.for("undici.globalDispatcher.2")] ?? globalThis[Symbol.for("undici.globalDispatcher.1")];
}

function prepare(launch) {
  new Request("data:,"); // initializes the built-in transport without network I/O
  if (![22, 24, 26].includes(Number(process.versions.node.split(".")[0])) ||
      typeof currentDispatcher()?.dispatch !== "function" ||
      launch.command !== process.execPath || launch.prefix.length !== 1 ||
      launch.prefix[0] !== launch.entry || digest(launch.entry) !== ENTRY_SHA256) {
    throw Object.assign(new Error("request budget unavailable for this runtime"), { status: "request_budget_unavailable" });
  }
  return { entry_sha256: ENTRY_SHA256, preload: require.resolve("./request-budget-preload.cjs"), level: "pinned_node_transport" };
}

function observation(directory, policy, modelRequests) {
  const exists = name => fs.existsSync(path.join(directory, name));
  const dispatched = exists("dispatched");
  let wireLimit = null;
  if (dispatched) {
    const raw = fs.readFileSync(path.join(directory, "dispatched"), "utf8").trim();
    if (/^[1-9][0-9]{0,5}$/.test(raw)) wireLimit = Number(raw);
  }
  const blocked = exists("blocked");
  let blockedReason = null;
  let blockedDetail;
  if (blocked) {
    const [raw, detail] = fs.readFileSync(path.join(directory, "blocked"), "utf8").trim().split("/");
    blockedReason = ["request_budget_exceeded", "output_limit_unverified", "output_limit_exceeded",
      "request_transport_unverified"].includes(raw) ? raw : "request_budget_unverified";
    if (blockedReason === "output_limit_unverified" && ["method", "endpoint", "body_type", "body_read", "body_size",
      "body_timeout", "body_aborted", "body_unavailable", "body_utf8", "json", "field_absent", "fields_ambiguous",
      "field_invalid", "http_stream", "project_token_body", "project_token_order",
      "project_token_destination", "project_token_duplicate"].includes(detail)) blockedDetail = detail;
  }
  return { limit: 1, attempts: Number(dispatched), project_token_exchanges: Number(exists("project-token-exchange")),
    blocked, blocked_reason: blockedReason,
    ...(blockedDetail ? { blocked_detail: blockedDetail } : {}),
    verified: exists("armed"), level: policy.level, entry_sha256: policy.entry_sha256, model_request_events: modelRequests,
    max_output_tokens: policy.max_output_tokens, wire_max_output_tokens: wireLimit,
    output_limit_verified: Number.isSafeInteger(wireLimit) && wireLimit <= policy.max_output_tokens };
}

module.exports = { prepare, observation, digest, currentDispatcher };
