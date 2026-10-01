import assert from "node:assert/strict";
import { test } from "node:test";
import { validatedOptions } from "../../services/shared/options.mjs";

test("profil se može pojedinačno izmijeniti uz validne granice", () => {
  const options = validatedOptions({ profile: "blog", format: "png", quality: "120", thumbnailWidth: "40" });

  assert.equal(options.profile, "blog");
  assert.equal(options.format, "png");
  assert.equal(options.quality, 95);
  assert.equal(options.thumbnail.width, 80);
  assert.equal(options.width, 1400);
});

test("watermark zahtijeva tekst kada je uključen", () => {
  assert.throws(
    () => validatedOptions({ profile: "custom", watermarkEnabled: "true", watermarkText: "  " }),
    /Unesite tekst watermarka/,
  );
});
