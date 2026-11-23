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
// Workers and forks inherit --require and the environment. Only the original
// CLI process acknowledges this wrapper; descendants initialize independently.
delete process.env.MMX_CHAT_FETCH_GUARD_STATUS;
try {
  if (!target) throw new Error("guard target missing");
  const { Agent, setGlobalDispatcher } = require(target);
  setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));
  if (process.env.MMX_CHAT_NATIVE_CLAIM) {
    const budget = require("./mmx-native-budget.js");
    if (statusFile) {
      const path = require("node:path");
      const entry = fs.realpathSync(process.argv[1]);
      if (!budget.supportedEntry(entry, path.dirname(path.dirname(entry)))) throw new Error("native entry changed");
    }
    budget.installFetchBudget(process.env.MMX_CHAT_NATIVE_CLAIM,
      Number(process.env.MMX_CHAT_NATIVE_MAX_TOKENS));
  }
  if (statusFile) {
    fs.writeFileSync(statusFile, "applied\n", { flag: "wx", mode: 0o600 });
  }
} catch {
  // No dependency paths, upstream text, configuration or credentials on stderr.
  // Exiting here stops Node before evaluating the paid CLI entry point.
  process.stderr.write("MMX fetch timeout guard could not initialize.\n");
  process.exit(78);
}
