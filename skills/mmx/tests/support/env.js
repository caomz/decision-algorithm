"use strict";

// Offline contract tests must be immune to the host proxy environment: when
// HTTP_PROXY/HTTPS_PROXY/NODE_USE_ENV_PROXY are inherited, every spawned node
// child constructs undici's EnvHttpProxyAgent, prints an experimental warning
// to stderr and would route its requests through the host proxy. cleanEnv
// builds the env for child processes from the current process.env with every
// proxy-related variable removed, then applies the caller's explicit overrides
// on top.

const PROXY_KEYS = [
  "HTTP_PROXY", "http_proxy",
  "HTTPS_PROXY", "https_proxy",
  "ALL_PROXY", "all_proxy",
  "NO_PROXY", "no_proxy",
  "NODE_USE_ENV_PROXY",
];

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of PROXY_KEYS) delete env[key];
  return { ...env, ...extra };
}

module.exports = { cleanEnv, PROXY_KEYS };
