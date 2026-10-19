// Loaded before application imports. Refuse unknown executables, including absolute paths.
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const allowed = new Set(
  JSON.parse(process.env.UBUME_OFFLINE_ALLOWLIST).map((p) => fs.realpathSync(p)),
);
function check(command, args) {
  let target = command;
  if (!path.isAbsolute(target)) {
    target = (process.env.PATH || "")
      .split(path.delimiter)
      .map((p) => path.join(p, command))
      .find((p) => fs.existsSync(p));
  }
  if (!target || !fs.existsSync(target) || !allowed.has(fs.realpathSync(target))) {
    throw new Error("OFFLINE EXECUTABLE BLOCKED: " + command);
  }
  fs.appendFileSync(
    "/bench/spawns.jsonl",
    JSON.stringify({ executable: fs.realpathSync(target), args, pid: process.pid }) + "\n",
  );
}
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
  const original = cp[name];
  cp[name] = function (command, args, ...rest) {
    check(command, args);
    return original.call(this, command, args, ...rest);
  };
}
for (const name of ["exec", "execSync", "fork"])
  cp[name] = () => {
    throw new Error("OFFLINE EXECUTABLE BLOCKED: " + name);
  };
require("node:module").syncBuiltinESMExports();
const realFetch = globalThis.fetch;
if (realFetch)
  globalThis.fetch = Object.assign(function (input, init) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      !["data:", "blob:", "file:"].includes(url.protocol) &&
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      throw new Error("OFFLINE NETWORK BLOCKED");
    return realFetch(input, init);
  }, realFetch);
