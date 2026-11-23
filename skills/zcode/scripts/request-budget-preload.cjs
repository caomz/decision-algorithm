"use strict";

// Runs before the pinned Node CLI. Only method and counters are inspected.
// Auth/TLS/proxy configuration and request contents belong to the native CLI.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { syncBuiltinESMExports } = require("node:module");
const { digest, currentDispatcher } = require("./request-budget.js");

const dir = process.env.ZCODE_WRAPPER_BUDGET_DIR;
const tokenLimit = Number(process.env.ZCODE_WRAPPER_OUTPUT_LIMIT);
if (!dir || digest(process.argv[1]) !== process.env.ZCODE_WRAPPER_ENTRY_SHA256) {
  throw new Error("ZCode request budget runtime mismatch");
}
if (!Number.isSafeInteger(tokenLimit) || tokenLimit < 1 || tokenLimit > 524288) throw new Error("invalid output budget");
function mark(name, value = 1) {
  fs.writeFileSync(path.join(dir, name), value + "\n", { flag: "wx", mode: 0o600 });
}
let denied = false;
function rejectDispatch(reason = "request_budget_exceeded") {
  denied = true;
  try { mark("blocked", reason); } catch (error) { if (error.code !== "EEXIST") throw error; }
  throw new Error("ZCode request budget prohibits this dispatch");
}
let dispatched = false;
function isReadOrTunnel(method) {
  return ["GET", "HEAD", "OPTIONS", "CONNECT"].includes(String(method ?? "GET").toUpperCase());
}
function reserve(method, wireLimit) {
  if (isReadOrTunnel(method)) return;
  if (denied) throw new Error("ZCode dispatch has already been refused");
  if (dispatched) rejectDispatch();
  if (!Number.isSafeInteger(wireLimit) || wireLimit < 1 || wireLimit > tokenLimit) rejectDispatch("output_limit_unverified");
  dispatched = true;
  try { mark("dispatched", wireLimit); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    rejectDispatch();
  }
}

// The audited model fetch adapters serialize JSON to a string. Only examine
// model endpoint bodies and the protocol's output-limit field. Never clone
// a stream, inspect headers, record the URL/body or rewrite the payload.
function outputLimit(input, init) {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (isReadOrTunnel(method)) return null;
  if (String(method).toUpperCase() !== "POST" || typeof init?.body !== "string") rejectDispatch("output_limit_unverified");
  let pathname;
  try { pathname = new URL(input instanceof Request ? input.url : input).pathname.replace(/\/$/, ""); }
  catch { rejectDispatch("output_limit_unverified"); }
  let fields;
  if (pathname.endsWith("/chat/completions")) fields = ["max_tokens", "max_completion_tokens"];
  else if (pathname.endsWith("/messages")) fields = ["max_tokens"];
  else if (pathname.endsWith("/responses")) fields = ["max_output_tokens"];
  else rejectDispatch("output_limit_unverified");
  let json;
  try { json = JSON.parse(init.body); } catch { rejectDispatch("output_limit_unverified"); }
  if (!json || typeof json !== "object" || Array.isArray(json)) rejectDispatch("output_limit_unverified");
  const present = fields.filter(field => Object.hasOwn(json, field));
  if (present.length !== 1) rejectDispatch("output_limit_unverified");
  const value = json[present[0]];
  if (!Number.isSafeInteger(value) || value < 1) rejectDispatch("output_limit_unverified");
  if (value > tokenLimit) rejectDispatch("output_limit_exceeded");
  return value;
}

// Initialize the bundled undici without performing network I/O. Node 26 uses
// dispatcher protocol 2, whereas Node 22/24 use protocol 1.
new Request("data:,");
const dispatcher = currentDispatcher();
if (typeof dispatcher?.dispatch !== "function") throw new Error("ZCode dispatch boundary unavailable");
const nativeFetch = globalThis.fetch;
globalThis.fetch = function fetchWithBudget(input, init) {
  const options = { ...init };
  if (currentDispatcher() !== dispatcher || (options.dispatcher && options.dispatcher !== dispatcher)) rejectDispatch("request_transport_unverified");
  const wireLimit = outputLimit(input, options);
  const guardedDispatcher = { dispatch(options, handler) {
    reserve(options.method, wireLimit);
    return dispatcher.dispatch(options, handler);
  } };
  return nativeFetch(input, { ...options, dispatcher: guardedDispatcher, redirect: "error" });
};
for (const transport of [http, https]) {
  const request = transport.request;
  transport.request = function requestWithBudget(input, ...args) {
    const options = typeof input === "string" || input instanceof URL ? args[0] : input;
    // The native proxy/CA branch streams the body after http.request creates
    // its socket. Its output cap cannot be proven before a write: fail closed.
    reserve(options?.method, null);
    return request.call(this, input, ...args);
  };
}
syncBuiltinESMExports();
mark("armed");
