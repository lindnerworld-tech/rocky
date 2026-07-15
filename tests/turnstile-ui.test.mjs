import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("shows a safe Turnstile diagnostic code when the widget fails", async () => {
  const html = await readFile(new URL("../WEBSITE/index.html", import.meta.url), "utf8");

  assert.match(html, /"error-callback"\(errorCode\)/);
  assert.match(html, /Turnstile error: \$\{safeErrorCode\}/);
  assert.match(html, /replace\(\/\[\^0-9A-Za-z_-\]\//);
});
