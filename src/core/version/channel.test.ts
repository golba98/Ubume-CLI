import assert from "node:assert/strict";
import test from "node:test";
import { APP_VERSION } from "../../config/settings.js";
import { formatUbumeBrandLabel, formatUbumeVersionLabel, isLocalDevChannel } from "./channel.js";

test("local-dev channel formats an obvious dev version label", () => {
  const env = { UBUME_CHANNEL: "local-dev" };
  assert.equal(isLocalDevChannel(env), true);
  assert.equal(formatUbumeVersionLabel(APP_VERSION, env), `${APP_VERSION}-dev local`);
  assert.equal(formatUbumeBrandLabel(env), `Ubume v${APP_VERSION}-dev local`);
});

test("the removed pre-rename CODEXA_CHANNEL variable no longer selects local-dev", () => {
  assert.equal(isLocalDevChannel({ CODEXA_CHANNEL: "local-dev" }), false);
});

test("published channel keeps normal version label", () => {
  const env = {};

  assert.equal(isLocalDevChannel(env), false);
  assert.equal(formatUbumeVersionLabel("0.1.0", env), "0.1.0");
});
