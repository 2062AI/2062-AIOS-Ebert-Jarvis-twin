// security-posture.js — infra-level TIER 1 enforcement (System Test SEC-1/SEC-5).
//
// Ebert's self-assessment flagged Loophole #3: if the dashboard were ever
// exposed to the network without auth/HTTPS, nothing in the engine would notice.
// This module makes that posture explicit, ENFORCED, and visible:
//
//   • assess()  — compute the current security posture from env/auth config.
//   • enforce() — fail CLOSED: refuse to start an exposed dashboard that has no
//                 auth, and warn loudly on exposed-without-HTTPS.
//
// The Docker port is published to 127.0.0.1 by default (see docker-compose.yml),
// so the dashboard is private unless the owner deliberately exposes it. When the
// owner sets DASHBOARD_PUBLIC=true (e.g. on the VPS behind a reverse proxy),
// these checks guarantee auth is on and nudge for TLS.

const auth = require("./auth");

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(process.env[name] || "");
}

// Compute the posture. Never throws.
function assess() {
  const authConfigured = auth.configured();
  // The owner's explicit declaration that the dashboard is reachable beyond
  // localhost. Default false → private, which matches the compose bind.
  const exposed = envFlag("DASHBOARD_PUBLIC");
  const publicUrl = process.env.PUBLIC_URL || "";
  const https = /^https:\/\//i.test(publicUrl) || envFlag("ASSUME_HTTPS");
  const bind = process.env.WEB_BIND || "127.0.0.1";

  const warnings = [];
  const errors = [];

  if (exposed && !authConfigured) {
    errors.push(
      "Dashboard is marked public (DASHBOARD_PUBLIC=true) but auth is NOT " +
        "configured. Set DASHBOARD_PASSWORD + SESSION_SECRET — refusing to serve " +
        "TIER 1 data without a login."
    );
  }
  if (exposed && !https) {
    warnings.push(
      "Dashboard is public but no HTTPS detected. Put it behind a TLS reverse " +
        "proxy and set PUBLIC_URL=https://your-host — otherwise TIER 1 traffic " +
        "(passwords, vault content) travels unencrypted."
    );
  }
  if (!exposed && !authConfigured) {
    warnings.push(
      "Auth not configured. Acceptable for localhost-only use, but set " +
        "DASHBOARD_PASSWORD + SESSION_SECRET before exposing the dashboard."
    );
  }

  let summary;
  if (!exposed) summary = "private (localhost-only)";
  else if (authConfigured && https) summary = "public + auth + HTTPS";
  else summary = "PUBLIC — needs review";

  return {
    authConfigured,
    exposed,
    https,
    bind,
    warnings,
    errors,
    safe: errors.length === 0,
    summary,
  };
}

// Fail-closed gate for startup. Logs warnings, throws if the posture is unsafe.
function enforce({ logger = console } = {}) {
  const p = assess();
  for (const w of p.warnings) logger.warn(`[security] ⚠️ ${w}`);
  if (!p.safe) {
    for (const e of p.errors) logger.error(`[security] ❌ ${e}`);
    throw new Error("Refusing to start — insecure dashboard exposure: " + p.errors.join(" "));
  }
  logger.log(
    `[security] posture: ${p.summary} ` +
      `(auth=${p.authConfigured ? "on" : "off"}, https=${p.https ? "yes" : "no"})`
  );
  return p;
}

module.exports = { assess, enforce };
