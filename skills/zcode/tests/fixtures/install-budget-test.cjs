"use strict";

// Loaded explicitly by offline test drivers, never selected through a
// production flag or environment variable. Only fixture entries are allowed.
const fs = require("node:fs");
const path = require("node:path");
const budget = require("../../scripts/request-budget.js");
const nativePrepare = budget.prepare;
budget.prepare = launch => {
  const stat = fs.statSync(launch.entry);
  const script = stat.size < 32 * 1024 ? fs.readFileSync(launch.entry, "utf8") : "";
  const fake = /(?:fake-zcode\.cjs|fake-zcode-cli\.cjs|round-cli\.cjs)/.test(script) ||
    path.basename(launch.entry) === "fake-zcode-cli.cjs";
  if (!fake) return nativePrepare(launch);
  return { entry_sha256: budget.digest(launch.entry), preload: require.resolve("./synthetic-budget.cjs"), level: "offline_fixture" };
};
