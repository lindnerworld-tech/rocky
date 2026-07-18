import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const website = new URL("../WEBSITE/", import.meta.url);

async function readPage(name) {
  return readFile(new URL(name, website), "utf8");
}

test("homepage links to public pricing and required policies", async () => {
  const html = await readPage("index.html");

  assert.match(html, /href="\/pricing\.html"/);
  assert.match(html, /href="\/terms\.html"/);
  assert.match(html, /href="\/refund-policy\.html"/);
  assert.match(html, /href="\/privacy\.html"/);
  assert.match(html, /support@rockyaloha\.com/);
});

test("legal pages identify the operator and provide reciprocal navigation", async () => {
  const names = [
    "pricing.html",
    "terms.html",
    "refund-policy.html",
    "privacy.html"
  ];
  const pages = await Promise.all(names.map(readPage));

  for (const html of pages) {
    assert.match(html, /Waikahe Orchards LLC/);
    assert.match(html, /support@rockyaloha\.com/);
    assert.match(html, /href="\/pricing\.html"/);
    assert.match(html, /href="\/terms\.html"/);
    assert.match(html, /href="\/refund-policy\.html"/);
    assert.match(html, /href="\/privacy\.html"/);
  }
});

test("pricing and refund pages disclose the approved plans and refund window", async () => {
  const pricing = await readPage("pricing.html");
  const refunds = await readPage("refund-policy.html");

  assert.match(pricing, /\$7\.99/);
  assert.match(pricing, /\$59/);
  assert.match(pricing, /20 AI-generated Rocky perspectives per day/);
  assert.match(refunds, /within 14 calendar days/);
  assert.match(refunds, /initial subscription purchase and to a renewal charge/);
});

test("privacy page discloses core Rocky processors without claiming card storage", async () => {
  const privacy = await readPage("privacy.html");

  for (const provider of ["Cloudflare", "Clerk", "OpenAI", "Paddle"]) {
    assert.match(privacy, new RegExp(provider));
  }
  assert.match(privacy, /do not receive or store your full payment-card number/);
  assert.match(privacy, /do not intentionally store the raw text/);
});
