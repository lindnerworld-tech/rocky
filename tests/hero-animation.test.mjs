import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const website = new URL("../WEBSITE/", import.meta.url);

test("Rocky has separate character and background layers", async () => {
  const [html, character, background] = await Promise.all([
    readFile(new URL("index.html", website), "utf8"),
    readFile(new URL("rocky-character.webp", website)),
    readFile(new URL("rocky-hero-background.jpg", website))
  ]);

  assert.match(html, /url\("rocky-hero-background\.jpg"\)/);
  assert.match(html, /class="rocky-character" src="rocky-character\.webp"/);
  assert.match(html, /class="rocky-eyelid rocky-eyelid-left"/);
  assert.match(html, /class="rocky-eyelid rocky-eyelid-right"/);
  assert.equal(character.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(character.subarray(8, 12).toString("ascii"), "WEBP");
  assert.deepEqual([...background.subarray(0, 2)], [0xff, 0xd8]);
});

test("Rocky's movement is subtle and honors reduced-motion preferences", async () => {
  const html = await readFile(new URL("index.html", website), "utf8");

  assert.match(html, /@keyframes rocky-sway/);
  assert.match(html, /rotate\(-\.35deg\)/);
  assert.match(html, /rotate\(\.35deg\)/);
  assert.match(html, /@keyframes rocky-blink-left/);
  assert.match(html, /@keyframes rocky-blink-right/);
  assert.match(html, /animation: rocky-sway 8s ease-in-out infinite/);
  assert.match(html, /animation-duration: 7\.8s/);
  assert.match(html, /animation-name: rocky-blink-left/);
  assert.match(html, /animation-name: rocky-blink-right/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(html, /\.rocky-character-motion,\s*\.rocky-eyelid \{ animation: none !important; \}/);
});
