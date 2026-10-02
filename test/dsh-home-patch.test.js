"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const homePatch = require("../hooks/dsh-home-patch");

const ENTRY = "/Users/king/.dsh/clawd-on-desk/bridge/lib/index.js";

test("the managed block names the bridge entry by absolute path", () => {
  const block = homePatch.renderManagedBlock(ENTRY);
  assert.match(block, /^# --- clawd-on-desk bridge: managed block, do not edit ---$/m);
  assert.match(block, /^# --- end clawd-on-desk bridge ---$/m);
  assert.match(block, /^- insert:$/m);
  assert.match(block, /^ {4}- id: clawd-bridge$/m);
  assert.match(block, new RegExp(`^ {6}name: '${ENTRY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'$`, "m"));
  assert.throws(() => homePatch.renderManagedBlock("relative/path.js"), homePatch.HomePatchError);
});

test("a fresh home gets a created block and the target path round-trips", () => {
  const plan = homePatch.planManagedBlockWrite("", ENTRY);
  assert.strictEqual(plan.action, "created");
  const found = homePatch.findManagedBlock(plan.content);
  assert.strictEqual(found.malformed, false);
  assert.strictEqual(found.present, true);
  assert.strictEqual(found.targetPath, ENTRY);
});

test("paths with spaces and quotes survive the YAML round-trip", () => {
  const tricky = "/Users/king/Library/Application Support/it's clawd/bridge/lib/index.js";
  const plan = homePatch.planManagedBlockWrite("", tricky);
  assert.strictEqual(homePatch.findManagedBlock(plan.content).targetPath, tricky);
  assert.match(plan.content, /name: '.*it''s clawd.*'/);
});

test("existing user entries are preserved and the block is appended", () => {
  const userContent = [
    "# my own patch layer",
    "- id: compaction-basic",
    "  config:",
    "    thresholdRatio: 0.5",
    "",
  ].join("\n");
  const plan = homePatch.planManagedBlockWrite(userContent, ENTRY);
  assert.strictEqual(plan.action, "created");
  assert.ok(plan.content.startsWith(userContent));
  assert.ok(plan.content.includes("thresholdRatio: 0.5"));
  assert.strictEqual(homePatch.findManagedBlock(plan.content).targetPath, ENTRY);
});

test("a comment-only home patch is appendable", () => {
  const plan = homePatch.planManagedBlockWrite("# nothing but a comment\n", ENTRY);
  assert.strictEqual(plan.action, "created");
  assert.strictEqual(homePatch.findManagedBlock(plan.content).targetPath, ENTRY);
});

test("an empty flow sequence is replaced rather than appended to", () => {
  const plan = homePatch.planManagedBlockWrite("[]\n", ENTRY);
  assert.strictEqual(plan.action, "created");
  assert.ok(!plan.content.includes("[]"));
  assert.strictEqual(homePatch.findManagedBlock(plan.content).targetPath, ENTRY);
});

test("a non-sequence document is refused instead of guessed at", () => {
  assert.throws(
    () => homePatch.planManagedBlockWrite("telemetry: off\n", ENTRY),
    homePatch.HomePatchError,
  );
});

test("writing the same entry twice is idempotent", () => {
  const first = homePatch.planManagedBlockWrite("", ENTRY);
  const second = homePatch.planManagedBlockWrite(first.content, ENTRY);
  assert.strictEqual(second.action, "unchanged");
  assert.strictEqual(second.content, first.content);
});

test("an existing block is updated in place and never duplicated", () => {
  const first = homePatch.planManagedBlockWrite("", "/old/bridge/lib/index.js");
  const second = homePatch.planManagedBlockWrite(first.content, ENTRY);
  assert.strictEqual(second.action, "updated");
  assert.strictEqual(homePatch.findManagedBlock(second.content).targetPath, ENTRY);
  assert.strictEqual(second.content.match(/clawd-on-desk bridge: managed block/g).length, 1);
});

test("an unbalanced or duplicated block fails closed", () => {
  const begin = homePatch.BLOCK_BEGIN;
  assert.strictEqual(homePatch.findManagedBlock(`${begin}\n- insert:\n`).malformed, true);
  const doubled = `${homePatch.renderManagedBlock(ENTRY)}${homePatch.renderManagedBlock(ENTRY)}`;
  assert.strictEqual(homePatch.findManagedBlock(doubled).malformed, true);
  assert.throws(() => homePatch.planManagedBlockWrite(`${begin}\n`, ENTRY), homePatch.HomePatchError);
  assert.throws(() => homePatch.planManagedBlockRemoval(`${begin}\n`), homePatch.HomePatchError);
});

test("removal takes only the managed block and leaves user content intact", () => {
  const userContent = ["# my own patch layer", "- id: compaction-basic", "  config: {}", ""].join("\n");
  const withBlock = homePatch.planManagedBlockWrite(userContent, ENTRY).content;
  const removed = homePatch.planManagedBlockRemoval(withBlock);
  assert.strictEqual(removed.action, "removed");
  assert.strictEqual(removed.content, userContent);
  assert.strictEqual(homePatch.planManagedBlockRemoval(removed.content).action, "absent");
});

test("removal cleans up a file that held nothing but the block", () => {
  const only = homePatch.planManagedBlockWrite("", ENTRY).content;
  const removed = homePatch.planManagedBlockRemoval(only);
  assert.strictEqual(removed.content, "");
});

test("install and uninstall cycles do not grow the file", () => {
  const userContent = "- id: keep-me\n";
  let content = userContent;
  for (let round = 0; round < 3; round += 1) {
    content = homePatch.planManagedBlockWrite(content, ENTRY).content;
    content = homePatch.planManagedBlockRemoval(content).content;
  }
  assert.strictEqual(content, userContent);
});

test("the patch path and stable entry live under the DSH home", () => {
  assert.strictEqual(
    homePatch.resolveHomePatchPath("/home/u/.dsh"),
    path.join("/home/u/.dsh", "cordis.patch.yml"),
  );
  assert.strictEqual(
    homePatch.resolveStableBridgeEntry("/home/u/.dsh"),
    path.join("/home/u/.dsh", "clawd-on-desk", "bridge", "lib", "index.js"),
  );
});

test("writing backs the previous file up before replacing it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-patch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "cordis.patch.yml");
  fs.writeFileSync(filePath, "- id: keep-me\n");

  const plan = homePatch.planManagedBlockWrite(fs.readFileSync(filePath, "utf8"), ENTRY);
  const result = await homePatch.writeHomePatchFile(filePath, plan);
  assert.strictEqual(result.action, "created");
  assert.ok(result.backupPath && fs.existsSync(result.backupPath));
  assert.strictEqual(fs.readFileSync(result.backupPath, "utf8"), "- id: keep-me\n");
  assert.strictEqual(homePatch.findManagedBlock(fs.readFileSync(filePath, "utf8")).targetPath, ENTRY);

  const noop = await homePatch.writeHomePatchFile(filePath, { action: "unchanged", content: "" });
  assert.strictEqual(noop.backupPath, null);
  assert.strictEqual(homePatch.findManagedBlock(fs.readFileSync(filePath, "utf8")).targetPath, ENTRY);
});

test("reading a missing home patch yields empty text rather than throwing", async () => {
  assert.strictEqual(await homePatch.readHomePatchFile("/nonexistent/cordis.patch.yml"), "");
});
