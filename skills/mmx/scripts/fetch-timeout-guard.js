"use strict";
// Preloaded into the mmx-cli child by mmx-chat.js (`node --require`).
// Node's built-in fetch (undici) gives up when response headers take longer
// than 300 s, and a non-streaming MiniMax reply sends its headers only once
// the reply is complete. Replace the global dispatcher with one that has no
// header or body timeout, using the undici copy the CLI itself imports
// (MMX_CHAT_UNDICI_PATH, resolved by the wrapper). The CLI's --timeout and the
// wrapper deadline still bound every request. Stay silent on failure: the CLI's
// stderr carries its JSON error envelope.
const target = process.env.MMX_CHAT_UNDICI_PATH;
if (target) {
  try {
    const { Agent, setGlobalDispatcher } = require(target);
    setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));
  } catch {}
}
