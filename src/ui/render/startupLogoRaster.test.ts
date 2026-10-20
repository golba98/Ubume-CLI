import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { decode } from "sixel";
import { startupLogoSvg } from "./startupLogoAsset.js";
import { rasterizeStartupLogo } from "./startupLogoRaster.js";

const svg = startupLogoSvg(
  { left: 0, right: 0 },
  { primary: "#ffffff", secondary: "#aaaaaa", highlight: "#ffffff" },
);
test("all image backends preserve the same pixel dimensions and continuous geometry", async () => {
  const options = { cellWidth: 19, cellHeight: 43, background: "#000000" };
  const kitty = await rasterizeStartupLogo(svg, { ...options, backend: "kitty" });
  const png = await sharp(kitty.png).metadata();
  assert.equal(png.width, 228);
  assert.equal(png.height, 129);
  for (const backend of ["iterm2", "sixel"] as const) {
    const asset = await rasterizeStartupLogo(svg, { ...options, backend });
    assert.equal(asset.tiles!.length, 3);
    for (let row = 0; row < 3; row++) {
      const tile = asset.tiles![row]!;
      let actual: Uint8Array;
      if (backend === "iterm2") {
        assert.match(tile, /inline=1;width=12;height=1/);
        const png = Buffer.from(tile.split(":")[1]!.slice(0, -1), "base64");
        const info = await sharp(png).metadata();
        assert.equal(info.width, 228);
        assert.equal(info.height, 43);
        actual = await sharp(png).flatten({ background: "#000" }).ensureAlpha().raw().toBuffer();
      } else {
        const decoded = decode(tile.slice(tile.indexOf("q") + 1, -2));
        assert.equal(decoded.width, 228);
        assert.equal(decoded.height, 43);
        actual = new Uint8Array(
          decoded.data32.buffer,
          decoded.data32.byteOffset,
          decoded.data32.byteLength,
        );
      }
      const expected = await sharp(kitty.png)
        .extract({ left: 0, top: row * 43, width: 228, height: 43 })
        .flatten({ background: "#000" })
        .ensureAlpha()
        .raw()
        .toBuffer();
      let mismatches = 0;
      for (let i = 0; i < expected.length; i += 4)
        if (Math.abs(actual[i]! - expected[i]!) > 20) mismatches++;
      assert.ok(
        mismatches < 228 * 43 * 0.02,
        `${backend} row ${row}: raster must not read pooled Buffer bytes`,
      );
    }
  }
});
test("raster cache reuses assets and changes dimensions without stretching", async () => {
  const options = {
    backend: "kitty" as const,
    cellWidth: 8,
    cellHeight: 20,
    background: "#000000",
  };
  assert.equal(rasterizeStartupLogo(svg, options), rasterizeStartupLogo(svg, options));
  const output = await rasterizeStartupLogo(svg, options);
  const { data, info } = await sharp(output.png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 96);
  assert.equal(info.height, 60);
  assert.equal(data[3], 0);
});
test("larger regions rasterize at full resolution with one tile per logo row", async () => {
  const size = { columns: 32, rows: 8 };
  const kitty = await rasterizeStartupLogo(svg, {
    backend: "kitty",
    cellWidth: 20,
    cellHeight: 48,
    background: "#000000",
    size,
  });
  const info = await sharp(kitty.png).metadata();
  assert.equal(info.width, 640);
  assert.equal(info.height, 384);
  const iterm = await rasterizeStartupLogo(svg, {
    backend: "iterm2",
    cellWidth: 10,
    cellHeight: 24,
    background: "#000000",
    size,
  });
  assert.equal(iterm.tiles!.length, 8);
  for (const tile of iterm.tiles!) assert.match(tile, /inline=1;width=32;height=1/);
});
test("a larger region keeps edges crisp: stroke interiors reach full opacity", async () => {
  const { data, info } = await sharp(
    (
      await rasterizeStartupLogo(svg, {
        backend: "kitty",
        cellWidth: 20,
        cellHeight: 48,
        background: "#000000",
        size: { columns: 40, rows: 10 },
      })
    ).png,
  )
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let opaque = 0;
  let partial = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] === 255) opaque++;
    else if (data[i]! > 0) partial++;
  }
  // The vector is rendered at the target size (not a scaled-up bitmap), so only
  // a thin anti-aliased edge is partially transparent.
  assert.ok(opaque > partial * 2, `opaque ${opaque} vs partial ${partial} at ${info.width}px`);
});
test("implausible regions are rejected before any pixels are allocated", async () => {
  for (const cellWidth of [0, 256, 10.01]) {
    await assert.rejects(
      rasterizeStartupLogo(svg, {
        backend: "kitty",
        cellWidth,
        cellHeight: 512,
        background: "#000000",
        size: { columns: 40, rows: 10 },
      }),
      RangeError,
    );
  }
});
