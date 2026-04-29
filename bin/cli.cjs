#!/usr/bin/env node
// Bin entry. Re-execs the TypeScript source under `bun` so the package works
// the same whether the caller used `bunx`, `npx`, or a global install.
"use strict";

const path = require("node:path");
const entry = path.join(__dirname, "..", "src", "index.ts");

if (process.versions.bun) {
  // Already running under bun (e.g. `bunx codex-cursor`); load the TS entry
  // directly so we don't pay for a second process.
  require(entry);
} else {
  const { spawn } = require("node:child_process");
  const child = spawn("bun", ["run", entry, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  child.on("error", (err) => {
    if (err && err.code === "ENOENT") {
      console.error(
        "codex-cursor requires the bun runtime. Install it from https://bun.sh and try again.",
      );
      process.exit(127);
    }
    console.error(err);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code == null ? 0 : code);
  });
}
