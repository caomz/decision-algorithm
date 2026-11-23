"use strict";

// Runs before the pinned Node CLI. Evidence contains only bounded categories
// and counters. Authentication and transport configuration stay with the CLI.
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
function rejectDispatch(reason = "request_budget_exceeded", detail) {
  denied = true;
  try { mark("blocked", detail ? reason + "/" + detail : reason); } catch (error) { if (error.code !== "EEXIST") throw error; }
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

function unverified(detail) { return rejectDispatch("output_limit_unverified", detail); }

function postUrl(input, method) {
  if (String(method).toUpperCase() !== "POST") unverified("method");
  try { return new URL(input instanceof Request ? input.url : input); }
  catch { unverified("endpoint"); }
}

function outputFields(url) {
  const pathname = url.pathname.replace(/\/$/, "");
  if (pathname.endsWith("/chat/completions")) return ["max_tokens", "max_completion_tokens"];
  if (pathname.endsWith("/messages")) return ["max_tokens"];
  if (pathname.endsWith("/responses")) return ["max_output_tokens"];
  unverified("endpoint");
}

// The pinned BigModel CLI exchanges an existing project's credential for a
// short-lived access token before the model POST. Key creation and other
// account operations have different paths and remain outside this allowance.
const PROJECT_TOKEN_ORIGIN = "https://bigmodel.cn";
const PROJECT_TOKEN_PATH = /^\/api\/biz\/v1\/organization\/[A-Za-z0-9_-]{1,128}\/projects\/[A-Za-z0-9_-]{1,128}\/api_keys\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}\/access_tokens$/;
const PROJECT_TOKEN_BODIES = ["0.0.0-dev", "0.17.1"]
  .map(clientVersion => JSON.stringify({ clientType: "zcode", clientVersion }));
function isProjectTokenUrl(url) {
  return url.origin === PROJECT_TOKEN_ORIGIN && !url.username && !url.password &&
    !url.search && !url.hash && PROJECT_TOKEN_PATH.test(url.pathname);
}

function projectTokenBody(body) {
  if (!(typeof body === "string" || body instanceof Uint8Array) || body.length > 128) {
    unverified("project_token_body");
  }
  const bytes = Buffer.from(body);
  if (!PROJECT_TOKEN_BODIES.includes(bytes.toString("utf8"))) unverified("project_token_body");
  return bytes;
}

function reserveProjectToken(expected, dispatch) {
  if (denied || dispatched) unverified("project_token_order");
  if (dispatch.method !== "POST" || dispatch.origin?.toString() !== PROJECT_TOKEN_ORIGIN ||
      dispatch.path !== expected.pathname) unverified("project_token_destination");
  try { mark("project-token-exchange"); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    unverified("project_token_duplicate");
  }
}

function outputLimit(text, fields) {
  let json;
  try { json = JSON.parse(text); } catch { unverified("json"); }
  if (!json || typeof json !== "object" || Array.isArray(json)) unverified("json");
  const present = fields.filter(field => Object.hasOwn(json, field));
  if (present.length !== 1) unverified(present.length ? "fields_ambiguous" : "field_absent");
  const value = json[present[0]];
  if (!Number.isSafeInteger(value) || value < 1) unverified("field_invalid");
  if (value > tokenLimit) rejectDispatch("output_limit_exceeded");
  return value;
}

// The runtime's option-map adapter also calls fetch(new Request(...)) after
// writing its mapped JSON. Snapshot a clone only on that path. The private
// bytes we verify are the bytes we send, even for a mutable underlying stream.
// A finite read deadline and byte/chunk caps bound inspection before I/O.
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
async function snapshotBody(request, signal) {
  if (request.bodyUsed || !request.body || request.body.locked) unverified("body_unavailable");
  if (signal?.aborted) unverified("body_aborted");
  let reader;
  try { reader = request.clone().body.getReader(); } catch { unverified("body_unavailable"); }
  const cancel = () => { reader.cancel().catch(() => {}); };
  let timedOut = false, complete = false;
  const timer = setTimeout(() => { timedOut = true; cancel(); }, 5000);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (timedOut) unverified("body_timeout");
      if (signal?.aborted) unverified("body_aborted");
      if (done) break;
      if (!(value instanceof Uint8Array)) unverified("body_type");
      size += value.byteLength;
      if (size > MAX_SNAPSHOT_BYTES || chunks.length >= 8192) unverified("body_size");
      chunks.push(Buffer.from(value));
    }
    complete = true;
    return Buffer.concat(chunks, size);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

// Initialize the bundled undici without performing network I/O. Node 26 uses
// dispatcher protocol 2, whereas Node 22/24 use protocol 1.
new Request("data:,");
const dispatcher = currentDispatcher();
if (typeof dispatcher?.dispatch !== "function") throw new Error("ZCode dispatch boundary unavailable");
const nativeFetch = globalThis.fetch;
globalThis.fetch = async function fetchWithBudget(input, init) {
  const options = { ...init };
  if (currentDispatcher() !== dispatcher || (options.dispatcher && options.dispatcher !== dispatcher)) rejectDispatch("request_transport_unverified");
  const method = options.method ?? (input instanceof Request ? input.method : "GET");
  let wireLimit = null;
  let projectTokenUrl = null;
  if (!isReadOrTunnel(method)) {
    const url = postUrl(input, method);
    if (isProjectTokenUrl(url)) {
      projectTokenUrl = url;
      options.body = projectTokenBody(options.body);
    } else {
      const fields = outputFields(url);
      if (typeof options.body === "string") {
        wireLimit = outputLimit(options.body, fields);
      } else if (options.body == null && input instanceof Request) {
        let bytes;
        try { bytes = await snapshotBody(input, options.signal ?? input.signal); }
        catch (error) { if (denied) throw error; unverified("body_read"); }
        let text;
        try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { unverified("body_utf8"); }
        wireLimit = outputLimit(text, fields);
        options.body = bytes;
      } else {
        unverified("body_type");
      }
    }
  }
  const guardedDispatcher = { dispatch(options, handler) {
    if (projectTokenUrl) reserveProjectToken(projectTokenUrl, options);
    else reserve(options.method, wireLimit);
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
    if (!isReadOrTunnel(options?.method) && !dispatched) unverified("http_stream");
    reserve(options?.method, null);
    return request.call(this, input, ...args);
  };
}
syncBuiltinESMExports();
mark("armed");
