"use strict";
// Replace only the copy of the wrapper selected by the batch in these tests.
// The production batch has no wrapper substitution via environment variables.
const path = require("node:path");
const cp = require("node:child_process");
if (path.basename(process.argv[1] || "") === "mmx-batch.js") {
  const spawn = cp.spawn;
  cp.spawn = function (command, args, options) {
    if (command === process.execPath && path.basename(args[0] || "") === "mmx-chat.js" && process.env.MMX_TEST_WRAPPER) {
      return spawn(command, [process.env.MMX_TEST_WRAPPER, ...args.slice(1)], options);
    }
    return spawn(command, args, options);
  };
}
