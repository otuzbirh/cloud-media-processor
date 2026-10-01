export const PROFILE_PRESETS = {
  webshop: {
    format: "webp",
    quality: 82,
    width: 1600,
    keepAspectRatio: true,
    thumbnail: { enabled: true, width: 320 },
    stripMetadata: true,
    watermark: { enabled: false, text: "", position: "southeast", opacity: 0.35 },
  },
  blog: {
    format: "webp",
    quality: 78,
    width: 1400,
    keepAspectRatio: true,
    thumbnail: { enabled: true, width: 400 },
    stripMetadata: true,
    watermark: { enabled: false, text: "", position: "southeast", opacity: 0.35 },
  },
  social: {
    format: "jpeg",
    quality: 86,
    width: 1080,
    keepAspectRatio: true,
    thumbnail: { enabled: true, width: 360 },
    stripMetadata: true,
    watermark: { enabled: false, text: "", position: "southeast", opacity: 0.35 },
  },
  custom: {
    format: "webp",
    quality: 78,
    width: 1600,
    keepAspectRatio: true,
    thumbnail: { enabled: false, width: 320 },
    stripMetadata: true,
    watermark: { enabled: false, text: "", position: "southeast", opacity: 0.35 },
  },
};

const FORMATS = new Set(["webp", "jpeg", "png"]);
const POSITIONS = new Set(["northwest", "north", "northeast", "west", "center", "east", "southwest", "south", "southeast"]);

function numberInRange(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true";
}

export function validatedOptions(body = {}) {
  const profile = Object.hasOwn(PROFILE_PRESETS, body.profile) ? body.profile : "custom";
  const preset = PROFILE_PRESETS[profile];
  const watermarkText = String(body.watermarkText ?? preset.watermark.text).trim().slice(0, 80);
  const watermarkEnabled = booleanValue(body.watermarkEnabled, preset.watermark.enabled);

  if (watermarkEnabled && watermarkText.length === 0) {
    throw new Error("Unesite tekst watermarka ili isključite watermark.");
  }

  return {
    profile,
    format: FORMATS.has(body.format) ? body.format : preset.format,
    quality: Math.round(numberInRange(body.quality, preset.quality, 35, 95)),
    width: Math.round(numberInRange(body.width, preset.width, 200, 8000)),
    keepAspectRatio: booleanValue(body.keepAspectRatio, preset.keepAspectRatio),
    thumbnail: {
      enabled: booleanValue(body.thumbnailEnabled, preset.thumbnail.enabled),
      width: Math.round(numberInRange(body.thumbnailWidth, preset.thumbnail.width, 80, 1200)),
    },
    stripMetadata: booleanValue(body.stripMetadata, preset.stripMetadata),
    watermark: {
      enabled: watermarkEnabled,
      text: watermarkText,
      position: POSITIONS.has(body.watermarkPosition) ? body.watermarkPosition : preset.watermark.position,
      opacity: numberInRange(body.watermarkOpacity, preset.watermark.opacity, 0.05, 1),
    },
  };
}
