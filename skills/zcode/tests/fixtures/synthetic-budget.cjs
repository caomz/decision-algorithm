"use strict";

// The fake CLIs use canned native events and do no I/O. Exercise the
// production pre-dispatch hook against a local, in-memory HTTP transport.
new Request("data:,");
const { currentDispatcher } = require("../../scripts/request-budget.js");
currentDispatcher().dispatch = () => true;
globalThis.fetch = (_input, init) => init.dispatcher.dispatch({ method: init.method });
require("../../scripts/request-budget-preload.cjs");
fetch("http://offline.invalid/v1/messages", { method: "POST", body: '{"max_tokens":1}' });
