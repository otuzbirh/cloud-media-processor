import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { imageMetadata, processImage, processImageOutputs } from "../../services/shared/image.mjs";

const sharp = createRequire(import.meta.url)("../../services/node_modules/sharp");

function svg(width, height, color) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/></svg>`);
}

test("pretvara i smanjuje sintetičku sliku u WebP", async () => {
  const input = svg(2400, 1600, "#227e5c");

  const output = await processImage(input, { format: "webp", quality: 78, width: 1200, keepAspectRatio: true });
  const metadata = await imageMetadata(output);

  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 800);
  assert.ok(output.length > 0);
});

test("podržava kvadratni JPEG izlaz", async () => {
  const input = svg(1200, 800, "#465a6e");

  const output = await processImage(input, { format: "jpeg", quality: 70, width: 500, keepAspectRatio: false });
  const metadata = await imageMetadata(output);

  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 500);
  assert.equal(metadata.height, 500);
});

test("generiše thumbnail i primjenjuje tekstualni watermark", async () => {
  const input = svg(1200, 800, "#3e6f91");
  const options = {
    format: "webp",
    quality: 80,
    width: 1000,
    keepAspectRatio: true,
    thumbnail: { enabled: true, width: 120 },
    stripMetadata: true,
    watermark: { enabled: true, text: "Dugi tekst watermarka za mali thumbnail", position: "southeast", opacity: 0.4 },
  };

  const { output, thumbnail } = await processImageOutputs(input, options);
  const [outputMetadata, thumbnailMetadata] = await Promise.all([imageMetadata(output), imageMetadata(thumbnail)]);

  assert.equal(outputMetadata.width, 1000);
  assert.equal(thumbnailMetadata.width, 120);
  assert.equal(outputMetadata.format, "webp");
});

test("uklanja EXIF kada je opcija uključena i zadržava ga kada nije", async () => {
  const input = await sharp(svg(400, 300, "#775548"))
    .jpeg()
    .withMetadata({ exif: { IFD0: { Artist: "Test autor" } } })
    .toBuffer();
  const baseOptions = { format: "jpeg", quality: 80, width: 400, keepAspectRatio: true, watermark: { enabled: false } };

  const [stripped, preserved] = await Promise.all([
    processImage(input, { ...baseOptions, stripMetadata: true }),
    processImage(input, { ...baseOptions, stripMetadata: false }),
  ]);
  const [strippedMetadata, preservedMetadata] = await Promise.all([imageMetadata(stripped), imageMetadata(preserved)]);

  assert.equal(strippedMetadata.exif, undefined);
  assert.ok(preservedMetadata.exif);
});
