"use strict";
// Preloaded into the mmx-cli child by mmx-chat.js (`node --require`).
// Node's built-in fetch (undici) gives up when response headers take longer
// than 300 s, and a non-streaming MiniMax reply sends its headers only once
// the reply is complete. Replace the global dispatcher with one that has no
// header or body timeout, using the undici copy the CLI itself imports
// (MMX_CHAT_UNDICI_PATH, resolved by the wrapper). The CLI's --timeout and the
// wrapper deadline still bound every request. A selected preload must initialize
// successfully before the CLI is allowed to send a request.
const fs = require("node:fs");
const target = process.env.MMX_CHAT_UNDICI_PATH;
const statusFile = process.env.MMX_CHAT_FETCH_GUARD_STATUS;
// Experiment-only instrumentation: when set, every dispatch through the
// installed agent is appended here, so an experiment can tell "initialized"
// from "actually used". It changes nothing about the dispatcher itself.
const traceFile = process.env.MMX_CHAT_GUARD_TRACE;
// Workers and forks inherit --require and the environment. Only the original
// CLI process acknowledges this wrapper; descendants initialize independently.
delete process.env.MMX_CHAT_FETCH_GUARD_STATUS;
delete process.env.MMX_CHAT_GUARD_TRACE;
try {
  if (!target) throw new Error("guard target missing");
  const { Agent, setGlobalDispatcher } = require(target);
  const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  if (traceFile) {
    const dispatch = agent.dispatch.bind(agent);
    agent.dispatch = (opts, handler) => {
      try { fs.appendFileSync(traceFile, JSON.stringify({ at_ms: Date.now(), origin: typeof opts?.origin === "string" ? opts.origin : null }) + "\n"); } catch {}
      return dispatch(opts, handler);
    };
  }
  setGlobalDispatcher(agent);
  if (statusFile) {
    fs.writeFileSync(statusFile, "applied\n", { flag: "wx", mode: 0o600 });
  }
} catch {
  // No dependency paths, upstream text, configuration or credentials on stderr.
  // Exiting here stops Node before evaluating the paid CLI entry point.
  process.stderr.write("MMX fetch timeout guard could not initialize.\n");
  process.exit(78);
}
