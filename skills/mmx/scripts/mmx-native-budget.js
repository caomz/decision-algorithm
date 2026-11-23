"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

// Audited npm mmx-cli 1.0.29 text chat calls global fetch with a JSON POST to
// /anthropic/v1/messages. Future transports need a new audit before dispatch.
const nativeSha256 = "f70cc9e43e141192fcdb69eb80577b15fcfac7a6c5a8341e90ca6d2ad1fc0522";
function supportedEntry(entry, root, observedDigest = crypto.createHash("sha256").update(fs.readFileSync(entry)).digest("hex")) {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  return metadata.name === "mmx-cli" && metadata.version === "1.0.29" &&
    observedDigest === nativeSha256;
}

function installFetchBudget(claim, maxTokens, target = globalThis) {
  if (typeof target.fetch !== "function" || !path.isAbsolute(claim) ||
      !Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error("invalid native request budget");
  const send = target.fetch.bind(target);
  target.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = String(options.method ?? input.method ?? "GET").toUpperCase();
    // Disallow automatic 307/308 replay, including redirects on other native
    // lookups onto the model route. Retain the CLI's auth and proxy handling.
    if (method === "GET" || method === "HEAD") {
      return send(input, { ...options, redirect: "error" });
    }
    function rejectBudget() {
      try { fs.writeFileSync(claim + ".blocked", "blocked\n", { flag: "wx", mode: 0o600 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      throw new Error("MMX native model request exceeded the approved budget");
    }
    // The audited CLI can refresh OAuth during a chat. Only its distinct
    // form-encoded auth routes may send a POST without spending the model claim.
    const oauthRoute = ["/oauth2/device/code", "/oauth2/token"].includes(url.pathname);
    const headers = new Headers(options.headers ?? input.headers);
    if (method === "POST" && oauthRoute &&
        headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/x-www-form-urlencoded") {
      return send(input, { ...options, redirect: "error" });
    }
    if (method !== "POST" || !url.pathname.endsWith("/anthropic/v1/messages")) return rejectBudget();
    let body;
    try { body = JSON.parse(options.body); } catch { return rejectBudget(); }
    if (!Number.isSafeInteger(body?.max_tokens) || body.max_tokens < 1 || body.max_tokens > maxTokens) {
      return rejectBudget();
    }
    try {
      // One atomic reservation per wrapper invocation, shared with inherited
      // workers. A failed send permanently consumes the reservation.
      fs.writeFileSync(claim, String(body.max_tokens) + "\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code === "EEXIST") return rejectBudget();
      throw error;
    }
    return send(input, { ...options, redirect: "error" });
  };
}

module.exports = { supportedEntry, installFetchBudget };
