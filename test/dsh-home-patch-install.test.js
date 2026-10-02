"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dsh = require("../hooks/dsh-install");
const homePatch = require("../hooks/dsh-home-patch");

/** An isolated DSH home plus a managed root, so nothing touches the real one. */
function makeHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-registration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dshHome = path.join(root, ".dsh");
  const homeDir = path.join(root, "home");
  fs.mkdirSync(path.join(dshHome, "profiles", "desktop"), { recursive: true });
  fs.writeFileSync(path.join(dshHome, "profiles", "desktop", "package.json"), "{}\n");
  fs.mkdirSync(homeDir, { recursive: true });
  return {
    dshHome,
    options: {
      dshHome,
      homeDir,
      managedRoot: path.join(root, "managed"),
      env: { DSH_HOME: dshHome },
    },
  };
}

test("the desktop app profile is what makes the machine-level route relevant", async (t) => {
  const { dshHome, options } = makeHome(t);
  assert.strictEqual(await dsh.isDesktopTargetPresent(options), true);
  assert.strictEqual(
    dsh.resolveDesktopProfileDir(dshHome),
    path.join(dshHome, "profiles", "desktop"),
  );
  assert.strictEqual(
    await dsh.isDesktopTargetPresent({ ...options, desktopTargetPresent: false }),
    false,
  );
});

test("registering writes a stable bridge copy and one managed home-patch block", async (t) => {
  const { dshHome, options } = makeHome(t);
  const result = await dsh.registerHomePatchBridge({ ...options, dshVersion: "0.2.0-rc.2" });
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.action, "created");

  // The stable copy carries the bridge files plus its ownership marker.
  for (const relative of ["package.json", "cordis.patch.yml", "lib/index.js", "clawd-manifest.json"]) {
    assert.ok(fs.existsSync(path.join(result.stableDir, ...relative.split("/"))), relative);
  }
  const marker = JSON.parse(fs.readFileSync(path.join(result.stableDir, "clawd-manifest.json"), "utf8"));
  assert.strictEqual(marker.owner, "clawd-on-desk");
  assert.strictEqual(marker.registration, "home-patch");
  assert.strictEqual(marker.installedDshVersion, "0.2.0-rc.2");

  // The patch names the stable entry, and nothing else was added.
  const content = fs.readFileSync(path.join(dshHome, "cordis.patch.yml"), "utf8");
  const found = homePatch.findManagedBlock(content);
  assert.strictEqual(found.malformed, false);
  assert.strictEqual(found.targetPath, result.stableEntry);

  const health = await dsh.inspectHomePatchRegistration(options);
  assert.strictEqual(health.status, "ok");
  assert.strictEqual(health.marker.bundleHash, marker.bundleHash);
});

test("re-registering is idempotent and does not duplicate the block", async (t) => {
  const { dshHome, options } = makeHome(t);
  await dsh.registerHomePatchBridge({ ...options, dshVersion: "0.2.0-rc.2" });
  const again = await dsh.registerHomePatchBridge({ ...options, dshVersion: "0.2.0-rc.2" });
  assert.strictEqual(again.status, "ok");
  assert.strictEqual(again.action, "unchanged");
  assert.strictEqual(again.created, false);
  const content = fs.readFileSync(path.join(dshHome, "cordis.patch.yml"), "utf8");
  assert.strictEqual(content.match(/clawd-on-desk bridge: managed block/g).length, 1);
});

test("existing user patch content survives registration and unregistration", async (t) => {
  const { dshHome, options } = makeHome(t);
  const patchPath = path.join(dshHome, "cordis.patch.yml");
  const userContent = "# my own patch layer\n- id: compaction-basic\n  config:\n    auto: true\n";
  fs.writeFileSync(patchPath, userContent);

  const registered = await dsh.registerHomePatchBridge({ ...options, dshVersion: "0.2.0-rc.2" });
  assert.strictEqual(registered.status, "ok");
  assert.ok(fs.readFileSync(patchPath, "utf8").startsWith(userContent));

  const removed = await dsh.unregisterHomePatchBridge(options);
  assert.strictEqual(removed.status, "ok");
  assert.strictEqual(removed.action, "removed");
  assert.strictEqual(fs.readFileSync(patchPath, "utf8"), userContent);
  assert.strictEqual(fs.existsSync(registered.stableDir), false, "the stable copy is cleaned up");
  assert.strictEqual((await dsh.inspectHomePatchRegistration(options)).status, "absent");
});

test("a home patch pointing somewhere else is reported, not rewritten", async (t) => {
  const { dshHome, options } = makeHome(t);
  const foreign = homePatch.planManagedBlockWrite("", "/somewhere/else/lib/index.js").content;
  fs.writeFileSync(path.join(dshHome, "cordis.patch.yml"), foreign);
  const health = await dsh.inspectHomePatchRegistration(options);
  assert.strictEqual(health.status, "foreign-target");
  assert.strictEqual(health.targetPath, "/somewhere/else/lib/index.js");
});

test("a malformed managed block fails closed instead of being guessed at", async (t) => {
  const { dshHome, options } = makeHome(t);
  fs.writeFileSync(path.join(dshHome, "cordis.patch.yml"), `${homePatch.BLOCK_BEGIN}\n`);
  const health = await dsh.inspectHomePatchRegistration(options);
  assert.strictEqual(health.status, "block-malformed");
  const result = await dsh.registerHomePatchBridge({ ...options, dshVersion: "0.2.0-rc.2" });
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "patch-not-editable");
});

test("an empty flow-sequence home patch is replaced rather than appended to", async (t) => {
  const { dshHome, options } = makeHome(t);
  fs.writeFileSync(path.join(dshHome, "cordis.patch.yml"), "[]\n");
  const result = await dsh.registerHomePatchBridge({ ...options, dshVersion: "0.2.0-rc.2" });
  assert.strictEqual(result.status, "ok");
  const content = fs.readFileSync(path.join(dshHome, "cordis.patch.yml"), "utf8");
  assert.ok(!content.includes("[]"));
  assert.strictEqual((await dsh.inspectHomePatchRegistration(options)).status, "ok");
});

test("the collision guard does not false-positive on a home with no bundle", async (t) => {
  const { options } = makeHome(t);
  const result = await dsh.registerHomePatchBridge({ ...options, dshVersion: "0.2.0-rc.2" });
  assert.strictEqual(result.status, "ok");
  const inspected = await dsh.inspectHomePatchRegistration(options);
  assert.strictEqual(inspected.status, "ok");
  assert.strictEqual(inspected.marker.registration, "home-patch");
});

test("sync takes the machine-level route when the desktop profile is present", async (t) => {
  const { dshHome, options } = makeHome(t);
  // No CLI at all: the desktop app's runtime is the only DSH on this machine,
  // which is exactly the case the profile route could never serve.
  const result = await dsh.syncDeepSeekHarnessIntegration({ ...options, dshCommand: false });
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(fs.existsSync(path.join(dshHome, "cordis.patch.yml")), true);
  const health = await dsh.inspectHomePatchRegistration(options);
  assert.strictEqual(health.status, "ok");
  assert.strictEqual(health.marker.installedDshVersionAssumedAtStaging, true);
  // Nothing was installed into a profile: the desktop route is patch-only.
  assert.strictEqual(fs.existsSync(path.join(dshHome, "profiles", "web", "package.json")), false);
});

test("sync keeps the profile route when no desktop profile exists", async (t) => {
  const { dshHome, options } = makeHome(t);
  fs.rmSync(path.join(dshHome, "profiles", "desktop"), { recursive: true, force: true });
  assert.strictEqual(await dsh.isDesktopTargetPresent(options), false);
  const result = await dsh.syncDeepSeekHarnessIntegration({ ...options, dshCommand: false });
  // Without a CLI the profile route reports its usual non-mutating outcome and
  // must not have written a home patch.
  assert.notStrictEqual(result.status, "ok");
  assert.strictEqual(fs.existsSync(path.join(dshHome, "cordis.patch.yml")), false);
});

test("the sync inspector the detection path uses agrees with the async one", async (t) => {
  const { options } = makeHome(t);
  assert.strictEqual(dsh.inspectHomePatchRegistrationSync(options).status, "absent");
  await dsh.registerHomePatchBridge({ ...options, dshVersion: "0.2.0-rc.2" });
  const syncHealth = dsh.inspectHomePatchRegistrationSync(options);
  const asyncHealth = await dsh.inspectHomePatchRegistration(options);
  assert.strictEqual(syncHealth.status, "ok");
  assert.strictEqual(syncHealth.status, asyncHealth.status);
  assert.strictEqual(syncHealth.stableEntry, asyncHealth.stableEntry);
  assert.strictEqual(syncHealth.marker.bundleHash, asyncHealth.marker.bundleHash);
});

test("unregister tears the machine-level registration down", async (t) => {
  const { dshHome, options } = makeHome(t);
  const registered = await dsh.syncDeepSeekHarnessIntegration({ ...options, dshCommand: false });
  assert.strictEqual(registered.status, "ok");
  const result = await dsh.unregisterDeepSeekHarness(options);
  assert.strictEqual(result.homePatchRemoved, true);
  assert.strictEqual(result.removed, true);
  assert.strictEqual(fs.existsSync(path.join(dshHome, "cordis.patch.yml")), false);
  assert.strictEqual((await dsh.inspectHomePatchRegistration(options)).status, "absent");
});
