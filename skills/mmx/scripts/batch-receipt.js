"use strict";

// The child's actual exit is an independent transport fact, not something
// that may be inferred from the JSON the child chose to print.
function verifyWrapperReceipt(receipt, actualExitCode, actualSignal) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
      typeof receipt.status !== "string") {
    return { status: "child_error", exit_code: actualExitCode,
      error: "wrapper envelope was invalid" };
  }
  if (actualSignal) {
    return { status: "child_error", exit_code: actualExitCode,
      error: "wrapper terminated by signal" };
  }
  if (receipt.status !== "ok") return receipt;
  if (actualExitCode !== 0 || receipt.exit_code !== 0 ||
      receipt.complete !== true || receipt.truncated !== false ||
      typeof receipt.text !== "string" || !receipt.text.trim()) {
    return { status: "child_error", exit_code: actualExitCode,
      error: "successful wrapper receipt contradicted process outcome or required fields" };
  }
  return receipt;
}

module.exports = { verifyWrapperReceipt };
