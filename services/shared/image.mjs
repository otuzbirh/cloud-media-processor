import sharp from "sharp";

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function watermarkOverlay(options, imageWidth, imageHeight) {
  if (!options.watermark?.enabled) return [];
  const width = Math.max(1, Math.min(imageWidth, Math.max(120, options.watermark.text.length * 18 + 32)));
  const height = Math.max(1, Math.min(imageHeight, 60));
  const padding = Math.min(16, Math.floor(width * 0.08));
  const fontSize = Math.max(8, Math.min(28, Math.floor(height * 0.5)));
  const textWidth = Math.max(1, width - padding * 2);
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><text x="${padding}" y="${Math.max(fontSize, Math.floor(height * 0.68))}" textLength="${textWidth}" lengthAdjust="spacingAndGlyphs" font-family="DejaVu Sans, sans-serif" font-size="${fontSize}" font-weight="600" fill="white" fill-opacity="${options.watermark.opacity}" stroke="black" stroke-opacity="${Math.min(0.35, options.watermark.opacity)}" stroke-width="1">${escapeXml(options.watermark.text)}</text></svg>`;
  return [{ input: Buffer.from(svg), gravity: options.watermark.position }];
}

function outputFormat(pipeline, options) {
  if (!options.stripMetadata) pipeline.keepMetadata();
  if (options.format === "jpeg") return pipeline.jpeg({ quality: options.quality, mozjpeg: true });
  if (options.format === "png") return pipeline.png({ quality: options.quality, compressionLevel: 9 });
  return pipeline.webp({ quality: options.quality, effort: 5 });
}

async function processAtWidth(buffer, options, width, forceInside = false) {
  const resize = options.keepAspectRatio
    ? { width, fit: "inside", withoutEnlargement: true }
    : { width, height: width, fit: forceInside ? "inside" : "fill", withoutEnlargement: true };
  const resized = sharp(buffer).rotate().resize(resize);
  if (!options.watermark?.enabled) return outputFormat(resized, options).toBuffer();
  if (!options.stripMetadata) resized.keepMetadata();
  const intermediate = await resized.toBuffer({ resolveWithObject: true });
  const pipeline = sharp(intermediate.data).composite(watermarkOverlay(options, intermediate.info.width, intermediate.info.height));
  return outputFormat(pipeline, options).toBuffer();
}

export async function processImage(buffer, options) {
  return processAtWidth(buffer, options, options.width);
}

export async function processImageOutputs(buffer, options) {
  const output = await processImage(buffer, options);
  const thumbnail = options.thumbnail?.enabled
    ? await processAtWidth(buffer, options, Math.min(options.width, options.thumbnail.width), true)
    : null;
  return { output, thumbnail };
}

export function imageMetadata(buffer) {
  return sharp(buffer).metadata();
}
