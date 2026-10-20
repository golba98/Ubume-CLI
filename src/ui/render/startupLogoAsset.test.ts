import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { THEMES } from "../theme.js";
import { STARTUP_LOGO_FRAMES } from "./startupAnimation.js";
import { startupLogoSvg } from "./startupLogoAsset.js";

test("the original SVG keeps solid geometry and transparent margins across themes and poses", async () => {
  for (const theme of Object.values(THEMES)) {
    const final = startupLogoSvg(
      { left: 0, right: 0 },
      { primary: theme.logoPrimary, secondary: theme.logoSecondary, highlight: theme.text },
    );
    assert.equal((final.match(/<polyline/g) ?? []).length, 3);
    assert.match(final, new RegExp(`stroke="${theme.logoPrimary}"`));
    assert.match(final, new RegExp(`stroke="${theme.logoSecondary}"`));
    const { data, info } = await sharp(Buffer.from(final))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 120);
    assert.equal(info.height, 72);
    assert.equal(info.channels, 4);
    assert.equal(data[3], 0, "corner remains transparent on light and dark terminals");
    assert.ok(data.some((value, index) => index % 4 === 3 && value === 255));
  }
  for (const frame of STARTUP_LOGO_FRAMES) {
    const svg = startupLogoSvg(
      frame.pose,
      { primary: "#aaaaaa", secondary: "#bbbbbb", highlight: "#cccccc" },
      frame.impact,
    );
    assert.equal(svg.includes('id="left"'), frame.pose.left !== null);
    assert.equal(svg.includes('id="right"'), frame.pose.right !== null);
    assert.ok(svg.includes('id="slash"'));
    assert.doesNotMatch(svg, /[\u2800-\u28ff\x1b]/);
  }
});
