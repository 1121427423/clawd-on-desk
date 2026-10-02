// Machine-level registration of the Clawd bridge in DeepSeek Harness.
//
// `$DSH_HOME/cordis.patch.yml` is DSH's home-level user patch layer. DSH's own
// profile-boot documentation is explicit about its reach: it is "applied over
// every profile's own layer" and carries "machine-local preferences that apply
// to every profile, so it outranks the per-profile layer". That reach is what
// lets Clawd's bridge load in profiles its installer could never mutate through
// the CLI — notably the Electron desktop app's reserved `desktop` profile,
// which `dsh plugin --profile desktop` refuses outright.
//
// A top-level `insert` entry may name the plugin by absolute path: DSH's
// root-include importer rewrites an absolute specifier with `pathToFileURL`
// before handing it to the module loader, so the bridge needs no pnpm install
// into any profile's node_modules.
//
// The file belongs to the user. Clawd owns exactly one marker-delimited block
// inside it and never rewrites a byte outside that block. A malformed home
// patch breaks the boot of EVERY profile, so every mutation here is
// fail-closed: the existing document must be a shape we can append to, the
// markers must be balanced, and the caller is expected to prove the composed
// tree still boots before keeping the write.
"use strict";

const fsp = require("fs").promises;
const path = require("path");

const HOME_PATCH_FILENAME = "cordis.patch.yml";
const MANAGED_DIR_NAME = "clawd-on-desk";
const BLOCK_BEGIN = "# --- clawd-on-desk bridge: managed block, do not edit ---";
const BLOCK_END = "# --- end clawd-on-desk bridge ---";
// Same loader-entry id the bundled profile patch uses. The two registration
// modes are mutually exclusive (a top-level `insert` appends without deduping,
// so both at once would mount the bridge twice), which keeps this id stable
// whichever route is active.
const ENTRY_ID = "clawd-bridge";

class HomePatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "HomePatchError";
  }
}

function splitLines(content) {
  return String(content).split("\n");
}

/** Lines that carry YAML meaning (comments and blank lines do not). */
function isMeaningfulLine(line) {
  const trimmed = line.trim();
  return trimmed !== "" && !trimmed.startsWith("#");
}

/**
 * Decide whether `content` is a document we may append a sequence item to.
 * Anything already carrying a non-sequence top-level shape is refused rather
 * than guessed at: a wrong guess would break every profile's boot.
 * @param content - the current file text ("" when the file does not exist).
 * @returns {"empty" | "sequence" | "empty-flow-sequence"} the appendable shape.
 * @throws {HomePatchError} when the document is not one Clawd may touch.
 */
function classifyAppendable(content) {
  const text = String(content);
  const meaningful = splitLines(text).filter(isMeaningfulLine);
  if (meaningful.length === 0) return "empty";
  if (meaningful.length === 1 && meaningful[0].trim() === "[]") return "empty-flow-sequence";
  if (meaningful[0].startsWith("-")) return "sequence";
  throw new HomePatchError(
    "refusing to edit a home patch that is not a top-level sequence"
  );
}

/** Quote one YAML scalar with single quotes (paths may contain spaces or quotes). */
function quoteYamlScalar(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Render the managed block for one bridge entry path.
 * @param entryPath - absolute path of the bridge's module entry file.
 * @returns the block text, newline-terminated.
 */
function renderManagedBlock(entryPath) {
  if (typeof entryPath !== "string" || !path.isAbsolute(entryPath)) {
    throw new HomePatchError("the bridge entry path must be absolute");
  }
  return [
    BLOCK_BEGIN,
    "- insert:",
    `    - id: ${ENTRY_ID}`,
    `      name: ${quoteYamlScalar(entryPath)}`,
    BLOCK_END,
    "",
  ].join("\n");
}

/**
 * Locate the managed block and the entry path it registers.
 * @param content - the current file text.
 * @returns `{ present, start, end, targetPath, malformed }`; `start`/`end` are
 *   line indexes of the marker lines (inclusive) when present.
 */
function findManagedBlock(content) {
  const lines = splitLines(content);
  const starts = [];
  const ends = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === BLOCK_BEGIN) starts.push(index);
    else if (trimmed === BLOCK_END) ends.push(index);
  }
  if (starts.length === 0 && ends.length === 0) {
    return { present: false, start: -1, end: -1, targetPath: null, malformed: false };
  }
  // Exactly one balanced block is the only shape Clawd will rewrite. Anything
  // else (duplicated, unbalanced, or reversed markers) needs a human.
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    return { present: true, start: -1, end: -1, targetPath: null, malformed: true };
  }
  const start = starts[0];
  const end = ends[0];
  let targetPath = null;
  for (let index = start + 1; index < end; index += 1) {
    const match = /^\s*name:\s*(.*?)\s*$/.exec(lines[index]);
    if (!match) continue;
    targetPath = match[1].replace(/^'(.*)'$/, "$1").replace(/''/g, "'").replace(/^"(.*)"$/, "$1");
  }
  return { present: true, start, end, targetPath, malformed: false };
}

/**
 * Plan the write that makes `content` register `entryPath`.
 * @param content - the current file text ("" when missing).
 * @param entryPath - absolute path of the bridge's module entry file.
 * @returns `{ action, content }` where action is `created`, `updated`, or `unchanged`.
 * @throws {HomePatchError} on a malformed block or an unappendable document.
 */
function planManagedBlockWrite(content, entryPath) {
  const block = renderManagedBlock(entryPath);
  const text = String(content || "");
  const found = findManagedBlock(text);
  if (found.malformed) {
    throw new HomePatchError("the managed home-patch block is malformed; manual inspection is required");
  }
  if (found.present) {
    const lines = splitLines(text);
    const next = [
      ...lines.slice(0, found.start),
      ...splitLines(block).slice(0, -1),
      ...lines.slice(found.end + 1),
    ].join("\n");
    return { action: next === text ? "unchanged" : "updated", content: next };
  }
  const shape = classifyAppendable(text);
  if (shape === "empty" || shape === "empty-flow-sequence") {
    return { action: "created", content: block };
  }
  const separator = text.endsWith("\n") ? "\n" : "\n\n";
  return { action: "created", content: `${text}${separator}${block}` };
}

/**
 * Plan the write that removes Clawd's block and leaves every other byte alone.
 * @param content - the current file text.
 * @returns `{ action, content }` where action is `removed`, `absent`, or `unchanged`.
 * @throws {HomePatchError} on a malformed block.
 */
function planManagedBlockRemoval(content) {
  const text = String(content || "");
  const found = findManagedBlock(text);
  if (found.malformed) {
    throw new HomePatchError("the managed home-patch block is malformed; manual inspection is required");
  }
  if (!found.present) return { action: "absent", content: text };
  const lines = splitLines(text);
  const kept = [...lines.slice(0, found.start), ...lines.slice(found.end + 1)];
  // Drop the blank separator the block was appended behind so repeated
  // install/uninstall cycles do not accumulate blank lines.
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  const next = kept.length === 0 ? "" : `${kept.join("\n")}\n`;
  return { action: next === text ? "unchanged" : "removed", content: next };
}

/**
 * Compare two entry paths the way the filesystem sees them.
 *
 * A DSH home reached through a symlink (macOS `/var` -> `/private/var`, or a
 * relocated home) yields two spellings of one file, so a raw string compare
 * would report Clawd's own block as a foreign target.
 * @param left - one path from the patch file or from Clawd.
 * @param right - the other path.
 * @param fsImpl - fs module used for the realpath probe.
 * @returns whether both names resolve to the same file.
 */
function sameEntryPath(left, right, fsImpl = require("fs")) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  const canonical = (value) => {
    const resolved = path.resolve(value);
    const suffix = [];
    let cursor = resolved;
    while (true) {
      try {
        return path.join(fsImpl.realpathSync(cursor), ...suffix);
      } catch {
        const parent = path.dirname(cursor);
        if (parent === cursor) return resolved;
        suffix.unshift(path.basename(cursor));
        cursor = parent;
      }
    }
  };
  return canonical(left) === canonical(right);
}

/** Absolute path of the home-level patch file for one DSH home. */
function resolveHomePatchPath(dshHome) {
  return path.join(path.resolve(dshHome), HOME_PATCH_FILENAME);
}

/** Absolute path of the stable directory the home patch points at. */
function resolveStableBridgeDir(dshHome) {
  return path.join(path.resolve(dshHome), MANAGED_DIR_NAME, "bridge");
}

/** The module entry file the home patch must name. */
function resolveStableBridgeEntry(dshHome) {
  return path.join(resolveStableBridgeDir(dshHome), "lib", "index.js");
}

async function readHomePatchFile(filePath) {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Apply a planned write atomically, backing up the previous file once.
 * @returns `{ action, backupPath }`.
 */
async function writeHomePatchFile(filePath, plan, options = {}) {
  if (plan.action === "unchanged") return { action: plan.action, backupPath: null };
  const fspImpl = options.fsp || fsp;
  await fspImpl.mkdir(path.dirname(filePath), { recursive: true });
  let backupPath = null;
  const existing = await readHomePatchFile(filePath);
  if (existing !== "") {
    backupPath = `${filePath}.clawd-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fspImpl.writeFile(backupPath, existing, { mode: 0o600 });
  }
  const tempPath = `${filePath}.clawd-tmp-${process.pid}-${Date.now()}`;
  if (plan.action === "removed" && plan.content === "") {
    // The file held nothing but Clawd's block, so there is no user content to
    // preserve and leaving an empty document behind would just be noise.
    await fspImpl.rm(filePath, { force: true });
    return { action: plan.action, backupPath };
  }
  await fspImpl.writeFile(tempPath, plan.content, { mode: 0o600 });
  await fspImpl.rename(tempPath, filePath);
  return { action: plan.action, backupPath };
}

module.exports = {
  BLOCK_BEGIN,
  BLOCK_END,
  ENTRY_ID,
  HOME_PATCH_FILENAME,
  MANAGED_DIR_NAME,
  HomePatchError,
  classifyAppendable,
  findManagedBlock,
  planManagedBlockRemoval,
  planManagedBlockWrite,
  readHomePatchFile,
  renderManagedBlock,
  resolveHomePatchPath,
  resolveStableBridgeDir,
  resolveStableBridgeEntry,
  sameEntryPath,
  writeHomePatchFile,
};
