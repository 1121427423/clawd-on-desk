"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dsh = require("../hooks/dsh-install");
const {
  BRIDGE_PACKAGE_NAME,
  BRIDGE_PROTOCOL_VERSION,
  MANAGED_OWNER,
  SUPPORTED_DSH_RANGE,
  SUPPORTED_DSH_VERSION,
} = dsh;
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
  // The inspect gate refuses a damaged block before the plan stage is reached.
  assert.strictEqual(result.reason, "block-malformed");
  assert.strictEqual(result.manualInspectionRequired, true);
});

test("a foreign target is refused before anything is written", async (t) => {
  const { dshHome, options } = makeHome(t);
  fs.writeFileSync(
    path.join(dshHome, "cordis.patch.yml"),
    homePatch.planManagedBlockWrite("", "/somewhere/else/lib/index.js").content,
  );
  const result = await dsh.registerHomePatchBridge({ ...options, dshVersion: "0.2.0-rc.2" });
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "foreign-target");
  assert.strictEqual(result.manualInspectionRequired, true);
  assert.strictEqual(
    fs.existsSync(homePatch.resolveStableBridgeDir(dshHome)),
    false,
    "the stable copy must not be materialized for a host Clawd refused",
  );
});

test("a failed composition check rolls the patch file back", async (t) => {
  const { dshHome, options } = makeHome(t);
  const patchPath = path.join(dshHome, "cordis.patch.yml");
  const userContent = "# mine\n- id: keep-me\n";
  fs.writeFileSync(patchPath, userContent);
  const result = await dsh.registerHomePatchBridge({
    ...options,
    dshVersion: "0.2.0-rc.2",
    validateCompositionImpl: async () => ({ ok: false, message: "simulated boot failure" }),
  });
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "patch-validation-failed");
  assert.strictEqual(result.rolledBack, true);
  assert.strictEqual(fs.readFileSync(patchPath, "utf8"), userContent);
});

test("a successful composition check keeps the write and reports a skip", async (t) => {
  const { dshHome, options } = makeHome(t);
  const result = await dsh.registerHomePatchBridge({
    ...options,
    dshVersion: "0.2.0-rc.2",
    validateCompositionImpl: async () => ({ ok: true, skipped: true, reason: "cli-unavailable" }),
  });
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.compositionValidationSkipped, "cli-unavailable");
  assert.strictEqual(
    dsh.inspectHomePatchRegistrationSync(options).status,
    "ok",
  );
  assert.strictEqual(fs.existsSync(path.join(dshHome, "cordis.patch.yml")), true);
});

test("uninstall never deletes a stable directory it does not own", async (t) => {
  const { dshHome, options } = makeHome(t);
  const stableDir = homePatch.resolveStableBridgeDir(dshHome);
  fs.mkdirSync(stableDir, { recursive: true });
  const foreignFile = path.join(stableDir, "someone-elses.txt");
  fs.writeFileSync(foreignFile, "not clawd\n");
  const result = await dsh.unregisterHomePatchBridge(options);
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.residualStableDir, true);
  assert.strictEqual(fs.existsSync(foreignFile), true, "foreign bytes must survive");
});

test("a damaged home patch warns instead of blocking the profile teardown", async (t) => {
  const { dshHome, options } = makeHome(t);
  fs.writeFileSync(path.join(dshHome, "cordis.patch.yml"), `${homePatch.BLOCK_BEGIN}\n`);
  const result = await dsh.unregisterDeepSeekHarness(options);
  assert.ok(result.homePatchWarning, "the home-patch failure is reported, not swallowed");
  assert.strictEqual(result.homePatchWarning.reason, "patch-not-editable");
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

/** Leave the profile route on disk exactly as the installer would. */
function fabricateProfileRoute({ dshHome, options }) {
  const profileDir = path.join(dshHome, "profiles", "web");
  fs.mkdirSync(profileDir, { recursive: true });
  const bridgeSource = path.join(__dirname, "..", "hooks", "dsh-clawd-bridge");
  const bundleHash = dsh.__test.hashBridgeDirectorySync(fs, bridgeSource);
  // Canonicalize the way the installer does: on macOS a temp path reached
  // through /var is a different spelling of the same file, and the resolver
  // compares the recorded generation path against the profile dependency.
  const managedRoot = dsh.resolveManagedRoot({
    homeDir: options.homeDir,
    dshHome,
    managedRoot: options.managedRoot,
  });
  const generationDir = path.join(managedRoot, "generations", bundleHash);
  const pluginDir = path.join(profileDir, "node_modules", ...BRIDGE_PACKAGE_NAME.split("/"));
  fs.cpSync(bridgeSource, generationDir, { recursive: true });
  fs.cpSync(bridgeSource, pluginDir, { recursive: true });
  const marker = {
    owner: MANAGED_OWNER,
    schemaVersion: 1,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    bundleHash,
    supportedDshRange: SUPPORTED_DSH_RANGE,
    installedDshVersion: SUPPORTED_DSH_VERSION,
  };
  fs.writeFileSync(path.join(generationDir, "clawd-manifest.json"), `${JSON.stringify(marker)}\n`);
  fs.writeFileSync(path.join(pluginDir, "clawd-manifest.json"), `${JSON.stringify(marker)}\n`);
  fs.writeFileSync(path.join(profileDir, "package.json"), `${JSON.stringify({
    name: "dsh-profile-web",
    dependencies: { [BRIDGE_PACKAGE_NAME]: `file:${generationDir}` },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", BRIDGE_PACKAGE_NAME] } },
  })}\n`);
  return { profileDir, generationDir, pluginDir };
}

/** Whether Clawd's managed block is present in the home patch. */
function homeEntryPresent(dshHome) {
  const patchPath = path.join(dshHome, "cordis.patch.yml");
  if (!fs.existsSync(patchPath)) return false;
  return homePatch.findManagedBlock(fs.readFileSync(patchPath, "utf8")).present;
}

test("a legacy profile route is reported as needing an explicit migration", async (t) => {
  const { dshHome, options } = makeHome(t);
  fabricateProfileRoute({ dshHome, options });
  const result = await dsh.syncDeepSeekHarnessIntegration({ ...options, dshCommand: false });
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "migration-required");
  assert.strictEqual(result.migrationRequired, true);
  assert.strictEqual(result.suggestedAction, "migrate-registration");
  assert.strictEqual(homeEntryPresent(dshHome), false, "nothing is migrated without being asked");
});

test("an explicit migration moves the registration and never leaves both live", async (t) => {
  const { dshHome, options } = makeHome(t);
  const { profileDir } = fabricateProfileRoute({ dshHome, options });
  const result = await dsh.migrateHomePatchRegistration(options);
  // The fixture has a live profile route and a desktop profile, so migration
  // must succeed here — pinning that keeps the invariant assertion below from
  // passing vacuously if migration ever stops working.
  assert.strictEqual(result.status, "ok", result.message);
  assert.strictEqual(result.migrated, true);
  assert.strictEqual(homeEntryPresent(dshHome), true);
  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, "package.json"), "utf8"));
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(manifest.dependencies || {}, BRIDGE_PACKAGE_NAME),
    false,
    "the old route is gone once the new one is live",
  );
  // And the guard the migration relies on now sees a clean host.
  assert.strictEqual(
    dsh.inspectDeepSeekHarnessDiskSync({ ...options, dshHome }).status,
    "absent",
  );
});

test("migration is a no-op when there is no profile route to move", async (t) => {
  const { options } = makeHome(t);
  const result = await dsh.migrateHomePatchRegistration(options);
  assert.strictEqual(result.status, "skipped");
  assert.strictEqual(result.reason, "no-profile-route");
});

test("the machine-level route refuses while a managed profile bundle is live", async (t) => {
  const { dshHome, options } = makeHome(t);
  fabricateProfileRoute({ dshHome, options });

  const result = await dsh.registerHomePatchBridge({ ...options, dshVersion: "0.2.0-rc.2" });
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "migration-required");
  assert.strictEqual(result.migrationRequired, true);
  assert.strictEqual(
    fs.existsSync(path.join(dshHome, "cordis.patch.yml")),
    false,
    "both routes at once would mount the bridge twice",
  );
});

test("a forged marker alone does not authorise replacing the stable copy", async (t) => {
  const { dshHome, options } = makeHome(t);
  const stableDir = homePatch.resolveStableBridgeDir(dshHome);
  fs.mkdirSync(stableDir, { recursive: true });
  fs.writeFileSync(path.join(stableDir, "clawd-manifest.json"), `${JSON.stringify({
    owner: MANAGED_OWNER,
    schemaVersion: 1,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    bundleHash: "0".repeat(64),
    supportedDshRange: SUPPORTED_DSH_RANGE,
    installedDshVersion: SUPPORTED_DSH_VERSION,
  })}\n`);
  const sentinel = path.join(stableDir, "sentinel.txt");
  fs.writeFileSync(sentinel, "keep\n");
  fs.writeFileSync(
    path.join(dshHome, "cordis.patch.yml"),
    homePatch.planManagedBlockWrite("", homePatch.resolveStableBridgeEntry(dshHome)).content,
  );
  assert.strictEqual(dsh.inspectHomePatchRegistrationSync(options).status, "marker-invalid");

  const result = await dsh.registerHomePatchBridge({ ...options, dshVersion: "0.2.0-rc.2" });
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "marker-invalid");
  assert.strictEqual(result.manualInspectionRequired, true);
  assert.strictEqual(fs.existsSync(sentinel), true, "the marker's own claim is not proof of authorship");
});

test("the composition check restores the profile root file it disturbed", async (t) => {
  const { dshHome, options } = makeHome(t);
  const profileDir = path.join(dshHome, "profiles", "web");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "package.json"), "{}\n");
  const rootPath = path.join(profileDir, "cordis.yml");
  const userContent = "# my own root file edit\n[]\n";
  fs.writeFileSync(rootPath, userContent);

  const result = await dsh.registerHomePatchBridge({
    ...options,
    dshVersion: "0.2.0-rc.2",
    commandInfo: { command: "dsh", prefixArgs: [], installRoot: null },
    // `dsh --dump-config` rewrites the profile root file as a composing side
    // effect, which is exactly the disturbance this guards against.
    runDshCommand: async () => {
      fs.writeFileSync(rootPath, "# dsh profile root — an empty entry list.\n[]\n");
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(fs.readFileSync(rootPath, "utf8"), userContent);
});

test("an idempotent sync does not spawn a composition check at all", async (t) => {
  const { dshHome, options } = makeHome(t);
  await dsh.registerHomePatchBridge({ ...options, dshVersion: "0.2.0-rc.2" });
  let spawned = 0;
  const again = await dsh.registerHomePatchBridge({
    ...options,
    dshVersion: "0.2.0-rc.2",
    commandInfo: { command: "dsh", prefixArgs: [], installRoot: null },
    runDshCommand: async () => {
      spawned += 1;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.strictEqual(again.status, "ok");
  assert.strictEqual(again.action, "unchanged");
  assert.strictEqual(spawned, 0, "an unchanged sync must not pay for a boot proof");
  assert.strictEqual(again.compositionValidationSkipped, "unchanged");
});

test("a desktop-only host still proves the entry loads even with no composable profile", async (t) => {
  const { dshHome, options } = makeHome(t);
  // The desktop app reserves its own profile and refuses the CLI, so this host
  // can never be composed — the entry check is the only proof available.
  fs.rmSync(path.join(dshHome, "profiles", "web"), { recursive: true, force: true });
  let spawned = 0;
  const result = await dsh.registerHomePatchBridge({
    ...options,
    dshVersion: "0.2.0-rc.2",
    commandInfo: { command: "dsh", prefixArgs: [], installRoot: null },
    runDshCommand: async () => {
      spawned += 1;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.entryVerified, true, "the entry must still be proven loadable");
  assert.strictEqual(result.compositionValidationSkipped, "no-composable-profile");
  assert.ok(result.compositionValidationWarning, "the skipped composition proof is reported, not silent");
  assert.strictEqual(spawned, 0);
});

test("an unloadable entry fails closed and rolls the patch back", async (t) => {
  const { dshHome, options } = makeHome(t);
  const patchPath = path.join(dshHome, "cordis.patch.yml");
  const userContent = "# mine\n- id: keep-me\n";
  fs.writeFileSync(patchPath, userContent);
  const result = await dsh.registerHomePatchBridge({
    ...options,
    dshVersion: "0.2.0-rc.2",
    verifyEntryImpl: async () => ({ ok: false, message: "simulated unloadable entry" }),
  });
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "entry-verification-failed");
  assert.strictEqual(result.rolledBack, true);
  assert.strictEqual(fs.readFileSync(patchPath, "utf8"), userContent);
});

test("the real bridge entry passes the host-independent check", async (t) => {
  const { options } = makeHome(t);
  const result = await dsh.registerHomePatchBridge({ ...options, dshVersion: "0.2.0-rc.2" });
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.entryVerified, true);
  // The check must reject a path that does not load, so verify it is not a
  // rubber stamp by pointing it at something that is not the bridge.
  const bogus = await dsh.__test.verifyHomePatchEntry(path.join(options.managedRoot, "nope.js"));
  assert.strictEqual(bogus.ok, false);
});

test("an output-capped dump loses the verdict instead of failing the write", async (t) => {
  const { dshHome, options } = makeHome(t);
  const profileDir = path.join(dshHome, "profiles", "web");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "package.json"), "{}\n");
  fs.writeFileSync(path.join(profileDir, "cordis.yml"), "[]\n");
  const result = await dsh.registerHomePatchBridge({
    ...options,
    dshVersion: "0.2.0-rc.2",
    commandInfo: { command: "dsh", prefixArgs: [], installRoot: null },
    // The cap kills the child, so the exit code says nothing about the patch.
    runDshCommand: async () => ({ code: 1, stdout: "", stderr: "", outputLimited: true }),
  });
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.compositionValidationSkipped, "composition-inconclusive");
  assert.ok(result.compositionValidationWarning);
  assert.strictEqual(fs.existsSync(path.join(dshHome, "cordis.patch.yml")), true);
});

test("a failing non-web profile does not fail the write", async (t) => {
  const { dshHome, options } = makeHome(t);
  // No web profile: the only candidate is a fallback whose dump errors.
  const tuiDir = path.join(dshHome, "profiles", "tui");
  fs.mkdirSync(tuiDir, { recursive: true });
  fs.writeFileSync(path.join(tuiDir, "package.json"), "{}\n");
  fs.writeFileSync(path.join(tuiDir, "cordis.yml"), "[]\n");
  // A backup directory must never even be considered a candidate.
  const backupDir = path.join(dshHome, "profiles", "web.bak");
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, "package.json"), "{}\n");
  fs.writeFileSync(path.join(backupDir, "cordis.yml"), "[]\n");

  const result = await dsh.registerHomePatchBridge({
    ...options,
    dshVersion: "0.2.0-rc.2",
    commandInfo: { command: "dsh", prefixArgs: [], installRoot: null },
    runDshCommand: async () => ({ code: 1, stdout: "", stderr: "boom" }),
  });
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.compositionValidationSkipped, "composition-inconclusive");
});

test("entry verification reflects the bytes on disk, not a cached module", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-entry-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, "entry.mjs");
  fs.writeFileSync(entry, "export function apply() {}\n");
  assert.strictEqual((await dsh.__test.verifyHomePatchEntry(entry, { cacheKey: "v1" })).ok, true);
  // Same path, different content: without a content-addressed specifier the
  // module cache would hand back the first import and report a false pass.
  fs.writeFileSync(entry, "export const nope = 1;\n");
  const stale = await dsh.__test.verifyHomePatchEntry(entry, { cacheKey: "v2" });
  assert.strictEqual(stale.ok, false, "the check must see the bytes that are there now");
});

test("a failed root-file restore is reported rather than swallowed", async (t) => {
  const { dshHome, options } = makeHome(t);
  const profileDir = path.join(dshHome, "profiles", "web");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "package.json"), "{}\n");
  const rootPath = path.join(profileDir, "cordis.yml");
  fs.writeFileSync(rootPath, "# mine\n[]\n");

  const result = await dsh.registerHomePatchBridge({
    ...options,
    dshVersion: "0.2.0-rc.2",
    commandInfo: { command: "dsh", prefixArgs: [], installRoot: null },
    fsp: {
      ...fs.promises,
      writeFile: async (file, data, opts) => {
        // Match by basename: the canonical DSH home rewrites /var to
        // /private/var, so an exact path compare would never fire here.
        if (String(file).endsWith("cordis.yml")) throw new Error("read-only root file");
        return fs.promises.writeFile(file, data, opts);
      },
    },
    runDshCommand: async () => {
      fs.writeFileSync(rootPath, "# rewritten by dsh\n[]\n");
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.strictEqual(result.status, "ok");
  assert.ok(result.compositionValidationWarning, "a lost user edit must never be silent");
  assert.match(result.compositionValidationWarning, /restoring it failed/);
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
