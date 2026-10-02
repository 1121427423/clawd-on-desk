#!/usr/bin/env node
"use strict";

const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");
const { spawn } = require("child_process");
const { asarUnpackedPath } = require("./json-utils");
const { resolveNodeBinAsync } = require("./server-config");
const homePatch = require("./dsh-home-patch");

const BRIDGE_PACKAGE_NAME = "@dsh-external/dsh-clawd-bridge";
const WEB_PROFILE_NAME = "web";
// Reserved by the Electron desktop app; `dsh plugin --profile desktop` refuses
// to touch it, which is why the machine-level home patch exists.
const DESKTOP_PROFILE_NAME = "desktop";
// The composed profile root DSH rewrites whenever it composes a profile tree,
// including a read-only-looking `--dump-config`.
const PROFILE_ROOT_FILE = "cordis.yml";
const DSH_RESTART_HINT = "DeepSeek Harness bridge verified on disk. Restart any running dsh web process to load this plugin generation.";
const MANAGED_OWNER = "clawd-on-desk";
const MANIFEST_FILE = "clawd-manifest.json";
const MANIFEST_SCHEMA_VERSION = 1;
const BRIDGE_PROTOCOL_VERSION = 1;
// Verified DSH versions, newest first. Each entry is an exact-version
// contract: the version, its exact supported range, and the npm artifact
// bound to it. New installs prefer the first entry; Repair, Uninstall, and
// manual commands select the contract whose version matches the detected
// host or the owned marker. Pre-release DSH versions are intentionally
// exact-pinned — a broad range (>=0.1.x) would admit artifacts this bridge
// has not verified.
const DSH_VERSION_CONTRACTS = Object.freeze([
  Object.freeze({
    version: "0.2.0-rc.2",
    supportedDshRange: "=0.2.0-rc.2",
    verifiedDshArtifact: "@deepseek-ai/dsh@0.2.0-rc.2",
    verifiedDshArtifactIntegrity: "sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA==",
  }),
  Object.freeze({
    version: "0.1.7-rc.2",
    supportedDshRange: "=0.1.7-rc.2",
    verifiedDshArtifact: "@deepseek-ai/dsh@0.1.7-rc.2",
    verifiedDshArtifactIntegrity: "sha512-SQFhriLvza8GnFApnC5/32AgpcyKxrWnYXhvwDOLJdgWpkCX2EexyR9c8kCkMITJXnFLEN3Qb2CEh0W36vkLyw==",
  }),
  Object.freeze({
    version: "0.1.5-rc.3",
    supportedDshRange: "=0.1.5-rc.3",
    verifiedDshArtifact: "@deepseek-ai/dsh@0.1.5-rc.3",
    verifiedDshArtifactIntegrity: "sha512-c0W6Xqc4ChjFcCJkbzPeIxZQdnbKqe+QAcJzWGtogg0ZzsnZRcw3vopMyZ5oZU6E2fmyqGcyDR1sBeiCH4yHcg==",
  }),
  Object.freeze({
    version: "0.1.5-rc.1",
    supportedDshRange: "=0.1.5-rc.1",
    verifiedDshArtifact: "@deepseek-ai/dsh@0.1.5-rc.1",
    verifiedDshArtifactIntegrity: "sha512-rmNmzQCg3oIc1z8xH7izRSOuy1TNzq+/NILyfM+7e8DKOyV+yBtg47WEsqR2SiIe1ATec3L/rUa1YhIcfQ2XEg==",
  }),
  Object.freeze({
    version: "0.1.1-rc.2",
    supportedDshRange: "=0.1.1-rc.2",
    verifiedDshArtifact: "@deepseek-ai/dsh@0.1.1-rc.2",
    verifiedDshArtifactIntegrity: "sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg==",
  }),
  Object.freeze({
    version: "0.1.0-rc.6",
    supportedDshRange: "=0.1.0-rc.6",
    verifiedDshArtifact: "@deepseek-ai/dsh@0.1.0-rc.6",
    verifiedDshArtifactIntegrity: "sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==",
  }),
]);
const PREFERRED_DSH_CONTRACT = DSH_VERSION_CONTRACTS[0];

// Backwards-compatible aliases for the preferred contract. Code that acts on a
// specific detected host or an owned marker should use dshContractForVersion /
// dshContractForMarker instead of these singletons.
const SUPPORTED_DSH_VERSION = PREFERRED_DSH_CONTRACT.version;
const SUPPORTED_DSH_RANGE = PREFERRED_DSH_CONTRACT.supportedDshRange;
const VERIFIED_DSH_ARTIFACT = PREFERRED_DSH_CONTRACT.verifiedDshArtifact;
const VERIFIED_DSH_ARTIFACT_INTEGRITY = PREFERRED_DSH_CONTRACT.verifiedDshArtifactIntegrity;
const SOURCE_AUDIT_BASELINE_COMMIT = "47f943859bef60e4160492346772ded9b24f765a";
const DEFAULT_OPERATION_TIMEOUT_MS = 120000;
const MUTATION_LOCK_SCHEMA_VERSION = 2;
const MUTATION_LOCK_STALE_MULTIPLIER = 2;
const MAX_MUTATION_LOCK_OPERATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MANUAL_GENERATION_REFERENCE_FILE = "manual-generation-reference.json";
const MANUAL_GENERATION_REFERENCE_SCHEMA_VERSION = 1;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const POSIX_DISCOVERABLE_COMMANDS = new Set(["dsh", "pnpm"]);
const BRIDGE_SOURCE_FILES = Object.freeze([
  "package.json",
  "cordis.patch.yml",
  "lib/index.js",
  "lib/clawd-client.js",
]);

let mutationTail = Promise.resolve();

function resolveDshHome(env = process.env) {
  const override = env && typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  return path.resolve(override || path.join(os.homedir(), ".dsh"));
}

function resolveDshProfileDir(dshHome) {
  return path.join(dshHome, "profiles", WEB_PROFILE_NAME);
}

function realpathSyncCanonical(fsImpl, value) {
  return fsImpl.realpathSync.native
    ? fsImpl.realpathSync.native(value)
    : fsImpl.realpathSync(value);
}

function resolveCanonicalDshHome(options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  // A running mutation already chose this identity; never resolve it again if
  // an ancestor is replaced while the operation is in progress.
  if (options.canonicalDshHome) return pathApi.resolve(options.canonicalDshHome);
  const configured = options.dshHome || resolveDshHome(options.env);
  const resolved = pathApi.resolve(configured);
  // DSH may create its home during plugin add. Resolve an existing ancestor
  // now so its managed namespace stays the same before and after that step.
  return platform === process.platform
    ? resolveCanonicalLocalPath(resolved, options)
    : resolved;
}

// Resolve symlinks in the deepest existing ancestor while preserving any
// not-yet-created suffix. DSH homes and managed roots may be created below a
// temporary or relocated parent whose lexical path differs from its real path
// (for example macOS /tmp -> /private/tmp). Keeping the future suffix lets
// first install and later ownership inspection agree without weakening
// marker/hash checks.
function resolveCanonicalLocalPath(value, options = {}) {
  const platform = options.platform || process.platform;
  const resolved = path.resolve(value);
  if (platform !== process.platform) return resolved;
  const fsImpl = options.fs || fs;
  const suffix = [];
  let cursor = resolved;
  while (true) {
    try {
      const realpath = realpathSyncCanonical(fsImpl, cursor);
      return path.join(realpath, ...suffix);
    } catch {}
    const parent = path.dirname(cursor);
    if (parent === cursor) return resolved;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
}

function freezeDshOperationOptions(options = {}) {
  const canonicalDshHome = resolveCanonicalDshHome(options);
  return {
    ...options,
    canonicalDshHome,
    dshHome: canonicalDshHome,
    env: {
      ...(options.env || process.env),
      DSH_HOME: canonicalDshHome,
    },
  };
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quotePosixShellLiteral(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildManualDshCommand(argv, options = {}) {
  const platform = options.platform || process.platform;
  const dshHome = resolveCanonicalDshHome(options);
  if (platform === "win32") {
    return `$env:DSH_HOME=${quotePowerShellLiteral(dshHome)}; & ${argv.map(quotePowerShellLiteral).join(" ")}`;
  }
  return `DSH_HOME=${quotePosixShellLiteral(dshHome)} ${argv.map(quotePosixShellLiteral).join(" ")}`;
}

function resolveManagedRoot(options = {}) {
  if (typeof options.managedRoot === "string" && options.managedRoot.trim()) {
    return resolveCanonicalLocalPath(options.managedRoot, options);
  }
  const homeDir = typeof options.homeDir === "string" && options.homeDir.trim()
    ? options.homeDir
    : os.homedir();
  let canonicalDshHome = resolveCanonicalDshHome(options);
  if ((options.platform || process.platform) === "win32") {
    canonicalDshHome = canonicalDshHome.toLowerCase();
  }
  const homeNamespace = crypto
    .createHash("sha256")
    .update(canonicalDshHome.replace(/\\/g, "/"), "utf8")
    .digest("hex");
  return path.join(
    resolveCanonicalLocalPath(homeDir, options),
    ".clawd",
    "integrations",
    "deepseek-harness",
    "homes",
    homeNamespace
  );
}

function resolveBridgeSourceDir(baseDir = __dirname) {
  return asarUnpackedPath(path.resolve(baseDir, "dsh-clawd-bridge"));
}

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(filePath) {
  try {
    return (await fsp.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function normalizeCommandResult(result) {
  if (!result || typeof result !== "object") return { code: 1, stdout: "", stderr: "" };
  return {
    code: Number.isInteger(result.code) ? result.code : (Number.isInteger(result.status) ? result.status : 1),
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout || ""),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr || ""),
    signal: result.signal || null,
    timedOut: result.timedOut === true,
    outputLimited: result.outputLimited === true,
  };
}

function runCommand(command, args, options = {}) {
  if (typeof options.runCommand === "function") {
    return Promise.resolve(options.runCommand(command, args, options)).then(normalizeCommandResult);
  }
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let outputLimited = false;
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : DEFAULT_OPERATION_TIMEOUT_MS;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(normalizeCommandResult({ ...result, stdout, stderr, timedOut, outputLimited }));
    };
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: 1, stdout: "", stderr: err && err.message ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
    }, timeoutMs);
    const collect = (kind) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        outputLimited = true;
        try { child.kill(); } catch {}
        return;
      }
      if (kind === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.on("error", (err) => finish({ code: 1, stderr: err && err.message ? err.message : String(err) }));
    child.on("close", (code, signal) => finish({ code: Number.isInteger(code) ? code : 1, signal }));
  });
}

async function whereCommands(command, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return [command];
  const result = await runCommand("where.exe", [command], { ...options, timeoutMs: 5000 });
  if (result.code !== 0) return [];
  return [...new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

async function whereCommand(command, options = {}) {
  return (await whereCommands(command, options))[0] || null;
}

function posixShellCandidates(options = {}) {
  const candidates = [];
  const add = (value) => {
    const candidate = typeof value === "string" ? value.trim() : "";
    if (!candidate || !path.posix.isAbsolute(candidate) || candidates.includes(candidate)) return;
    candidates.push(candidate);
  };
  add(options.shellPath);
  add(options.env && options.env.SHELL);
  add(process.env.SHELL);
  add("/bin/zsh");
  add("/bin/bash");
  add("/bin/sh");
  return candidates;
}

async function executablePathFromShellOutput(raw, options = {}) {
  const access = options.access || fsp.access.bind(fsp);
  const lines = String(raw || "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index].trim();
    if (!candidate || !path.posix.isAbsolute(candidate) || candidate.includes("\0")) continue;
    try {
      await access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

async function resolvePosixExecutable(command, options = {}) {
  if (!POSIX_DISCOVERABLE_COMMANDS.has(command)) return null;
  for (const shell of posixShellCandidates(options)) {
    for (const shellMode of ["-lc", "-lic"]) {
      const located = await runCommand(shell, [shellMode, `command -v ${command}`], {
        ...options,
        timeoutMs: 5000,
      });
      if (located.code !== 0) continue;
      const resolved = await executablePathFromShellOutput(located.stdout, options);
      if (resolved) return resolved;
    }
  }
  return null;
}

function buildPosixCommandEnv(options = {}, commandInfo = null, executables = []) {
  const env = {
    ...(options.env || process.env),
    ...((commandInfo && commandInfo.env) || {}),
  };
  const currentEntries = typeof env.PATH === "string"
    ? env.PATH.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean)
    : [];
  const preferredEntries = executables
    .filter((entry) => typeof entry === "string" && path.posix.isAbsolute(entry))
    .map((entry) => path.posix.dirname(entry));
  env.PATH = [...new Set([...preferredEntries, ...currentEntries])].join(path.delimiter);
  return env;
}

function commandExecutionOptions(commandInfo, options = {}) {
  if (!commandInfo || !commandInfo.env) return options;
  return {
    ...options,
    env: {
      ...(options.env || process.env),
      ...commandInfo.env,
    },
  };
}

function expandShimCandidate(candidate, shim, platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const shimDir = pathApi.dirname(shim);
  let expanded = String(candidate || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/%~?dp0%?/gi, `${shimDir}${pathApi.sep}`)
    .replace(/\$\{?basedir\}?/gi, shimDir)
    .replace(/\$PSScriptRoot/gi, shimDir);
  // Strip command syntax that may precede an unquoted path in a shim line.
  expanded = expanded.replace(/^(?:exec\s+)?(?:node(?:\.exe)?\s+|&\s*)/i, "").trim();
  if (!pathApi.isAbsolute(expanded)) expanded = pathApi.resolve(shimDir, expanded);
  return pathApi.normalize(expanded);
}

function extractDshBinCandidates(shim, raw, platform) {
  const candidates = [];
  const matches = String(raw || "").matchAll(
    /([^"'\r\n]*node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js)/gi
  );
  for (const match of matches) {
    const expanded = expandShimCandidate(match[1], shim, platform);
    if (expanded) candidates.push(expanded);
  }
  return [...new Set(candidates)];
}

async function readShimBinCandidates(shim, platform) {
  if (/\.exe$/i.test(shim)) return [];
  try {
    const stat = await fsp.stat(shim);
    if (!stat.isFile() || stat.size > 256 * 1024) return [];
    return extractDshBinCandidates(shim, await fsp.readFile(shim, "utf8"), platform);
  } catch {
    return [];
  }
}

async function resolveNodeRunner(options = {}) {
  if (typeof options.nodeBin === "string" && options.nodeBin.trim()) return options.nodeBin.trim();
  if (typeof options.resolveNodeBinAsyncImpl === "function") {
    return options.resolveNodeBinAsyncImpl(options);
  }
  return resolveNodeBinAsync(options);
}

async function resolveDshCommand(options = {}) {
  if (options.commandInfo && typeof options.commandInfo === "object") {
    return options.commandInfo;
  }
  if (options.dshCommand === false || options.dshCommand === null) return null;
  if (options.dshCommand && typeof options.dshCommand === "object") {
    return {
      command: options.dshCommand.command,
      prefixArgs: Array.isArray(options.dshCommand.prefixArgs) ? options.dshCommand.prefixArgs : [],
      installRoot: options.dshCommand.installRoot || null,
    };
  }
  if (typeof options.dshCommand === "string" && options.dshCommand.trim()) {
    return { command: options.dshCommand.trim(), prefixArgs: [], installRoot: null };
  }
  const platform = options.platform || process.platform;
  if (platform !== "win32") {
    const bin = await resolvePosixExecutable("dsh", options);
    if (!bin) return null;
    let realBin = bin;
    try { realBin = await fsp.realpath(bin); } catch {}
    const normalized = realBin.replace(/\\/g, "/");
    let binJs = normalized.endsWith("/lib/bin.js") ? realBin : null;
    if (!binJs) {
      const parsed = await readShimBinCandidates(bin, platform);
      for (const candidate of parsed) {
        if (await exists(candidate)) {
          binJs = candidate;
          break;
        }
      }
    }
    const installRoot = binJs ? path.dirname(path.dirname(binJs)) : null;
    const nodeRunner = await resolveNodeRunner(options);
    const env = buildPosixCommandEnv(options, null, [nodeRunner, bin]);
    if (nodeRunner && binJs) {
      return { command: nodeRunner, prefixArgs: [binJs], installRoot, env };
    }
    return { command: bin, prefixArgs: [], installRoot, env };
  }
  const shims = await whereCommands("dsh", options);
  if (shims.length === 0) return null;
  const candidates = [];
  for (const shim of shims) {
    candidates.push(path.join(path.dirname(shim), "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
    candidates.push(...await readShimBinCandidates(shim, platform));
  }
  const nodeRunner = await resolveNodeRunner(options);
  if (nodeRunner) {
    for (const binJs of [...new Set(candidates)]) {
      if (!(await exists(binJs))) continue;
      const packageRoot = path.dirname(path.dirname(binJs));
      return { command: nodeRunner, prefixArgs: [binJs], installRoot: packageRoot };
    }
  }
  const executable = shims.find((shim) => /\.exe$/i.test(shim));
  if (executable) return { command: executable, prefixArgs: [], installRoot: null };
  return null;
}

function parseDshVersion(value) {
  const match = String(value || "").match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : null;
}

function dshContractForVersion(version) {
  return DSH_VERSION_CONTRACTS.find((contract) => contract.version === version) || null;
}

function isSupportedDshVersion(version) {
  return dshContractForVersion(version) !== null;
}

function supportedDshRangeLabel() {
  return DSH_VERSION_CONTRACTS.map((contract) => contract.supportedDshRange).join(" or ");
}

// Resolve the exact contract an installed generation was staged for. A marker
// whose installedDshVersion is not in the table, or whose supportedDshRange
// disagrees with its version's contract, is unlisted and returns null.
function dshContractForMarker(marker) {
  if (!marker || typeof marker.installedDshVersion !== "string") return null;
  const contract = dshContractForVersion(marker.installedDshVersion);
  if (!contract || marker.supportedDshRange !== contract.supportedDshRange) return null;
  return contract;
}

async function readDshVersion(commandInfo, options = {}) {
  if (typeof options.dshVersion === "string") return parseDshVersion(options.dshVersion);
  if (!commandInfo) return null;
  const result = await runCommand(commandInfo.command, [...commandInfo.prefixArgs, "--version"], {
    ...commandExecutionOptions(commandInfo, options),
    timeoutMs: 5000,
  });
  if (result.code !== 0) return null;
  return parseDshVersion(`${result.stdout}\n${result.stderr}`);
}

async function hasDshCommand(options = {}) {
  if (typeof options.dshCommandAvailable === "boolean") return options.dshCommandAvailable;
  const command = await resolveDshCommand(options);
  if (!command) return false;
  const result = await runCommand(command.command, [...command.prefixArgs, "--version"], {
    ...commandExecutionOptions(command, options),
    timeoutMs: 5000,
  });
  return result.code === 0;
}

async function resolvePnpmRuntime(commandInfo, options = {}) {
  if (typeof options.pnpmAvailable === "boolean") {
    return { available: options.pnpmAvailable, commandInfo };
  }
  if ((options.platform || process.platform) === "win32") {
    return { available: !!(await whereCommand("pnpm", options)), commandInfo };
  }
  const pnpmCommand = await resolvePosixExecutable("pnpm", options);
  if (!pnpmCommand) return { available: false, commandInfo };
  const nodeRunner = await resolveNodeRunner(options);
  const env = buildPosixCommandEnv(options, commandInfo, [pnpmCommand, nodeRunner]);
  const result = await runCommand(pnpmCommand, ["--version"], {
    ...options,
    env,
    timeoutMs: 5000,
  });
  return {
    available: result.code === 0,
    commandInfo: commandInfo ? { ...commandInfo, env } : commandInfo,
  };
}

async function hasPnpm(options = {}) {
  return (await resolvePnpmRuntime(null, options)).available;
}

async function isDshInstalled(options = {}) {
  if (typeof options.dshInstalled === "boolean") return options.dshInstalled;
  const home = options.dshHome || resolveDshHome(options.env);
  if (await isDirectory(home)) {
    for (const name of ["profiles", "sessions", "storages"]) {
      if (await isDirectory(path.join(home, name))) return true;
    }
  }
  return hasDshCommand(options);
}

async function runDshCommand(args, options = {}) {
  try {
    if (typeof options.runDshCommand === "function") {
      return normalizeCommandResult(await options.runDshCommand(args, options));
    }
    const command = await resolveDshCommand(options);
    if (!command) return { code: 127, stdout: "", stderr: "dsh command is not available" };
    return runCommand(
      command.command,
      [...command.prefixArgs, ...args],
      commandExecutionOptions(command, options),
    );
  } catch (err) {
    return {
      code: 1,
      stdout: "",
      stderr: err && err.message ? err.message : String(err),
    };
  }
}

function packagePath(root, packageName) {
  return path.join(root, "node_modules", ...packageName.split("/"), "package.json");
}

function managedProfileRemovalResidueLocation(options = {}) {
  const dshHome = options.dshHome || resolveDshHome(options.env);
  const profileDir = resolveDshProfileDir(dshHome);
  const linkDir = path.dirname(packagePath(profileDir, BRIDGE_PACKAGE_NAME));
  return {
    dir: path.dirname(linkDir),
    prefix: `${path.basename(linkDir)}.clawd-removing-`,
  };
}

function listManagedProfileRemovalResiduesSync(fsImpl, options = {}) {
  const { dir, prefix } = managedProfileRemovalResidueLocation(options);
  try {
    return {
      paths: fsImpl.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.name.startsWith(prefix))
        .map((entry) => path.join(dir, entry.name))
        .sort(),
      unreadableError: null,
    };
  } catch (err) {
    if (err && err.code === "ENOENT") return { paths: [], unreadableError: null };
    return { paths: [], unreadableError: err || new Error("DSH profile link directory is unreadable") };
  }
}

async function listManagedProfileRemovalResidues(options = {}) {
  const { dir, prefix } = managedProfileRemovalResidueLocation(options);
  try {
    return {
      paths: (await fsp.readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.name.startsWith(prefix))
        .map((entry) => path.join(dir, entry.name))
        .sort(),
      unreadableError: null,
    };
  } catch (err) {
    if (err && err.code === "ENOENT") return { paths: [], unreadableError: null };
    return { paths: [], unreadableError: err || new Error("DSH profile link directory is unreadable") };
  }
}

function managedProfileRemovalResidueHealth(scan, options = {}) {
  if (!scan || (!scan.unreadableError && scan.paths.length === 0)) return null;
  const dshHome = options.dshHome || resolveDshHome(options.env);
  return {
    status: "inspection-required",
    healthReason: "profile-removal-residue",
    dshHome,
    profileDir: resolveDshProfileDir(dshHome),
    dependencyPresent: false,
    bundlePresent: false,
    owned: false,
    resolved: null,
    residuePath: scan.paths[0] || managedProfileRemovalResidueLocation(options).dir,
    residuePaths: scan.paths,
    residueScanFailed: !!scan.unreadableError,
    manualInspectionRequired: true,
  };
}

function managedProfileRemovalResidueResult(health) {
  return {
    status: "error",
    reason: "inspection-required",
    healthReason: "profile-removal-residue",
    residuePath: health.residuePath,
    residuePaths: health.residuePaths,
    message: "A previous DeepSeek Harness profile-link cleanup was interrupted; inspect the exact residue path before retrying",
    manualInspectionRequired: true,
  };
}

function digestBridgeFiles(files, contract = PREFERRED_DSH_CONTRACT) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  hash.update(`protocol:${BRIDGE_PROTOCOL_VERSION}\0`);
  hash.update(`dsh:${contract.supportedDshRange}\0`);
  return hash.digest("hex");
}

async function hashBridgeDirectory(packageDir, contract = PREFERRED_DSH_CONTRACT) {
  try {
    const files = [];
    for (const relativePath of BRIDGE_SOURCE_FILES) {
      const filePath = path.join(packageDir, ...relativePath.split("/"));
      const stat = await fsp.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      files.push({ relativePath, content: await fsp.readFile(filePath) });
    }
    return digestBridgeFiles(files, contract);
  } catch {
    return null;
  }
}

function hashBridgeDirectorySync(fsImpl, packageDir, contract = PREFERRED_DSH_CONTRACT) {
  try {
    const files = [];
    for (const relativePath of BRIDGE_SOURCE_FILES) {
      const filePath = path.join(packageDir, ...relativePath.split("/"));
      const stat = typeof fsImpl.lstatSync === "function"
        ? fsImpl.lstatSync(filePath)
        : fsImpl.statSync(filePath);
      if (!stat.isFile() || (typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink())) return null;
      files.push({ relativePath, content: fsImpl.readFileSync(filePath) });
    }
    return digestBridgeFiles(files, contract);
  } catch {
    return null;
  }
}

// Hash the current bridge source once per verified contract so health checks
// can compare an installed marker against the source hash for the exact
// contract it was staged for (never against another contract's hash).
function computeExpectedSourceHashesSync(fsImpl, sourceDir) {
  try {
    const files = [];
    for (const relativePath of BRIDGE_SOURCE_FILES) {
      const filePath = path.join(sourceDir, ...relativePath.split("/"));
      const stat = typeof fsImpl.lstatSync === "function"
        ? fsImpl.lstatSync(filePath)
        : fsImpl.statSync(filePath);
      if (!stat.isFile() || (typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink())) return null;
      files.push({ relativePath, content: fsImpl.readFileSync(filePath) });
    }
    const hashes = {};
    for (const contract of DSH_VERSION_CONTRACTS) {
      hashes[contract.version] = digestBridgeFiles(files, contract);
    }
    return hashes;
  } catch {
    return null;
  }
}

function dependencySourcePath(spec, profileDir, platform = process.platform) {
  if (typeof spec !== "string" || !spec.trim()) return null;
  const match = spec.trim().match(/^(?:file|link):(.*)$/i);
  if (!match || !match[1]) return null;
  let value = match[1];
  try { value = decodeURIComponent(value); } catch {}
  if (platform === "win32" && /^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.resolve(profileDir, value);
}

async function inspectResolvedPackage(packageManifestPath, anchor) {
  if (!packageManifestPath || !(await exists(packageManifestPath))) return null;
  let realManifestPath;
  try {
    realManifestPath = await fsp.realpath(packageManifestPath);
  } catch {
    realManifestPath = packageManifestPath;
  }
  const packageManifest = await readJson(realManifestPath);
  const packageDir = path.dirname(realManifestPath);
  const clawdManifest = await readJson(path.join(packageDir, MANIFEST_FILE));
  const markerContract = dshContractForMarker(clawdManifest);
  const actualBundleHash = await hashBridgeDirectory(packageDir, markerContract || PREFERRED_DSH_CONTRACT);
  return { anchor, packageDir, packageManifest, clawdManifest, actualBundleHash };
}

function readJsonSync(fsImpl, filePath) {
  try {
    let raw = fsImpl.readFileSync(filePath, "utf8");
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readInspectionLatchSync(fsImpl, options = {}) {
  const filePath = inspectionLatchPath(options);
  try {
    if (!fsImpl.statSync(filePath).isFile()) return null;
  } catch {
    return null;
  }
  return readJsonSync(fsImpl, filePath) || { invalid: true, reason: "inspection-latch-invalid" };
}

function inspectResolvedPackageSync(fsImpl, packageManifestPath, anchor) {
  try {
    if (!fsImpl.statSync(packageManifestPath).isFile()) return null;
  } catch {
    return null;
  }
  let realManifestPath = packageManifestPath;
  try {
    realManifestPath = realpathSyncCanonical(fsImpl, packageManifestPath);
  } catch {}
  const packageManifest = readJsonSync(fsImpl, realManifestPath);
  const packageDir = path.dirname(realManifestPath);
  const clawdManifest = readJsonSync(fsImpl, path.join(packageDir, MANIFEST_FILE));
  const markerContract = dshContractForMarker(clawdManifest);
  const actualBundleHash = hashBridgeDirectorySync(fsImpl, packageDir, markerContract || PREFERRED_DSH_CONTRACT);
  return { anchor, packageDir, packageManifest, clawdManifest, actualBundleHash };
}

function dshCommandPathsSync(options = {}) {
  const fsImpl = options.fs || fs;
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const pathValue = typeof env.PATH === "string" && env.PATH.trim()
    ? env.PATH
    : (typeof env.Path === "string" ? env.Path : "");
  const names = platform === "win32"
    ? ["dsh", "dsh.cmd", "dsh.ps1", "dsh.exe"]
    : ["dsh"];
  const separator = platform === "win32" ? ";" : ":";
  const results = [];
  for (const entry of pathValue.split(separator).map((value) => value.trim()).filter(Boolean)) {
    for (const name of names) {
      const candidate = pathApi.join(entry, name);
      try {
        if (fsImpl.statSync(candidate).isFile()) results.push(candidate);
      } catch {}
    }
  }
  return [...new Set(results)];
}

function resolveDshInstallRootSync(options = {}) {
  const fsImpl = options.fs || fs;
  const platform = options.platform || process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  for (const shim of dshCommandPathsSync(options)) {
    let realShim = shim;
    try { realShim = realpathSyncCanonical(fsImpl, shim); } catch {}
    const normalized = realShim.replace(/\\/g, "/");
    if (normalized.endsWith("/lib/bin.js")) return pathApi.dirname(pathApi.dirname(realShim));
    const candidates = [
      pathApi.join(pathApi.dirname(shim), "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    ];
    if (!/\.exe$/i.test(shim)) {
      try {
        const stat = fsImpl.statSync(shim);
        if (stat.isFile() && stat.size <= 256 * 1024) {
          candidates.push(...extractDshBinCandidates(shim, fsImpl.readFileSync(shim, "utf8"), platform));
        }
      } catch {}
    }
    for (const binJs of candidates) {
      try {
        if (fsImpl.statSync(binJs).isFile()) return pathApi.dirname(pathApi.dirname(binJs));
      } catch {}
    }
  }
  return null;
}

function isMarkerOwned(record) {
  const marker = record && record.clawdManifest;
  return !!(
    record
    && record.packageManifest
    && record.packageManifest.name === BRIDGE_PACKAGE_NAME
    && marker
    && marker.owner === MANAGED_OWNER
    && marker.schemaVersion === MANIFEST_SCHEMA_VERSION
    && marker.protocolVersion === BRIDGE_PROTOCOL_VERSION
    && typeof marker.bundleHash === "string"
    && marker.bundleHash
  );
}

function isIntactManaged(record) {
  return isMarkerOwned(record)
    && typeof record.actualBundleHash === "string"
    && record.actualBundleHash === record.clawdManifest.bundleHash;
}

function isManagedGenerationRecord(record, managedRoot, options = {}) {
  if (!isIntactManaged(record) || !managedRoot) return false;
  const platform = options.platform || process.platform;
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  // Canonicalize only the namespace root. Following a symlink at the generation
  // leaf would let a marker-looking package outside the managed namespace claim
  // ownership. inspectResolvedPackage* already realpaths record.packageDir, so
  // a leaf that escapes the canonical root must stay a mismatch.
  const expected = path.join(
    resolveCanonicalLocalPath(managedRoot, options),
    "generations",
    record.clawdManifest.bundleHash
  );
  return normalize(record.packageDir) === normalize(expected);
}

function classifyDeepSeekHarnessProfile({
  dshHome,
  profileDir,
  profileManifest,
  installationResolved,
  profileResolved,
  fallbackResolved,
  sourceResolved,
  managedGenerationResolved,
  sourcePath,
  managedRoot,
  expectedHashes,
  fs: fsImpl,
  platform,
}) {
  const dependencies = profileManifest.dependencies && typeof profileManifest.dependencies === "object"
    ? profileManifest.dependencies
    : {};
  const bundles = profileManifest.dsh
    && profileManifest.dsh.profile
    && Array.isArray(profileManifest.dsh.profile.bundles)
    ? profileManifest.dsh.profile.bundles
    : [];
  const dependencySpec = dependencies[BRIDGE_PACKAGE_NAME] || null;
  const dependencyPresent = Object.prototype.hasOwnProperty.call(dependencies, BRIDGE_PACKAGE_NAME);
  const bundlePresent = bundles.includes(BRIDGE_PACKAGE_NAME);
  // Official bundle resolution is ordered, not a quorum: installation first,
  // then the profile-local package, then Node's parent-walk flat fallback only
  // when the profile-local package is absent. A stale/foreign lower-priority
  // fallback must not poison a healthy profile-local winner.
  const effectiveFallbackResolved = profileResolved ? null : fallbackResolved;
  const resolved = installationResolved || profileResolved || effectiveFallbackResolved;
  const profileOwned = isIntactManaged(profileResolved);
  const fallbackOwned = isIntactManaged(effectiveFallbackResolved);
  const ownershipOptions = { fs: fsImpl, platform };
  const sourceOwned = isManagedGenerationRecord(sourceResolved, managedRoot, ownershipOptions);
  const managedGenerationOwned = isManagedGenerationRecord(managedGenerationResolved, managedRoot, ownershipOptions);
  const ownershipRecord = sourceOwned
    ? sourceResolved
    : (managedGenerationOwned ? managedGenerationResolved : null);
  const owned = !!ownershipRecord;
  const marker = (resolved && resolved.clawdManifest)
    || (ownershipRecord && ownershipRecord.clawdManifest)
    || null;
  let status = "absent";

  if (dependencyPresent || bundlePresent) {
    if (installationResolved) {
      status = "profile-entry-foreign-or-conflicting";
    } else if (profileResolved && !isMarkerOwned(profileResolved)) {
      status = "profile-entry-foreign-or-conflicting";
    } else if (profileResolved && isMarkerOwned(profileResolved) && !profileOwned) {
      status = "generation-integrity-failed";
    } else if (effectiveFallbackResolved && !isMarkerOwned(effectiveFallbackResolved)) {
      status = "profile-entry-foreign-or-conflicting";
    } else if (effectiveFallbackResolved && isMarkerOwned(effectiveFallbackResolved) && !fallbackOwned) {
      status = "generation-integrity-failed";
    } else if (sourceResolved && !isMarkerOwned(sourceResolved)) {
      status = "profile-entry-foreign-or-conflicting";
    } else if (sourceResolved && isMarkerOwned(sourceResolved) && !isIntactManaged(sourceResolved)) {
      status = "generation-integrity-failed";
    } else if (sourceResolved && !sourceOwned) {
      status = "profile-entry-foreign-or-conflicting";
    } else if (dependencyPresent && !sourcePath) {
      status = "profile-entry-foreign-or-conflicting";
    } else if (dependencyPresent !== bundlePresent) {
      status = owned ? "profile-entry-incomplete" : "profile-entry-foreign-or-conflicting";
    } else if ((!profileResolved && !effectiveFallbackResolved) || (sourcePath && !sourceResolved)) {
      status = owned ? "managed-bundle-missing" : "profile-entry-foreign-or-conflicting";
    } else if (!profileOwned && !fallbackOwned) {
      status = "profile-entry-foreign-or-conflicting";
    } else if (!dshContractForMarker(marker)) {
      status = "version-unsupported";
    } else if (expectedHashes && marker.bundleHash !== expectedHashes[marker.installedDshVersion]) {
      status = "generation-mismatch";
    } else {
      status = "healthy";
    }
  } else if (owned && profileResolved && isMarkerOwned(profileResolved)) {
    status = isIntactManaged(profileResolved)
      ? "managed-residue"
      : "generation-integrity-failed";
  }

  return {
    status,
    dshHome,
    profileDir,
    profileManifest,
    dependencySpec,
    dependencySourcePath: sourcePath || null,
    dependencyPresent,
    bundlePresent,
    installationResolved,
    profileResolved,
    fallbackResolved,
    sourceResolved,
    managedGenerationResolved,
    resolved,
    owned,
    managedRoot,
    marker,
  };
}

function inspectDeepSeekHarnessDiskSync(options = {}) {
  const fsImpl = options.fs || fs;
  const dshHome = options.dshHome || resolveDshHome(options.env);
  const profileDir = resolveDshProfileDir(dshHome);
  const removalResidueHealth = managedProfileRemovalResidueHealth(
    listManagedProfileRemovalResiduesSync(fsImpl, options),
    options
  );
  if (removalResidueHealth) return removalResidueHealth;
  const profileManifestPath = path.join(profileDir, "package.json");
  const profileManifest = readJsonSync(fsImpl, profileManifestPath);
  if (!profileManifest) {
    let profileManifestExists = false;
    try { profileManifestExists = fsImpl.statSync(profileManifestPath).isFile(); } catch {}
    const latch = readInspectionLatchSync(fsImpl, options);
    return {
      status: latch ? "inspection-required" : (profileManifestExists ? "profile-corrupt" : "profile-missing"),
      dshHome,
      profileDir,
      dependencyPresent: false,
      bundlePresent: false,
      owned: false,
      resolved: null,
      ...(latch ? { inspectionLatch: latch } : {}),
    };
  }
  const dependencies = profileManifest.dependencies && typeof profileManifest.dependencies === "object"
    ? profileManifest.dependencies
    : {};
  const dependencySpec = dependencies[BRIDGE_PACKAGE_NAME] || null;
  const sourcePath = dependencySourcePath(dependencySpec, profileDir, options.platform || process.platform);
  const dshInstallRoot = options.dshInstallRoot !== undefined
    ? options.dshInstallRoot
    : resolveDshInstallRootSync({ ...options, fs: fsImpl });
  const dshPackageManifest = dshInstallRoot
    ? readJsonSync(fsImpl, path.join(dshInstallRoot, "package.json"))
    : null;
  const detectedDshVersion = dshPackageManifest && typeof dshPackageManifest.version === "string"
    ? parseDshVersion(dshPackageManifest.version)
    : null;
  const installationManifest = dshInstallRoot
    ? packagePath(dshInstallRoot, BRIDGE_PACKAGE_NAME)
    : null;
  const installationResolved = inspectResolvedPackageSync(fsImpl, installationManifest, "installation");
  const profileResolved = inspectResolvedPackageSync(
    fsImpl,
    packagePath(profileDir, BRIDGE_PACKAGE_NAME),
    "profile"
  );
  const fallbackResolved = inspectResolvedPackageSync(
    fsImpl,
    packagePath(path.join(dshHome, "profiles"), BRIDGE_PACKAGE_NAME),
    "profiles-fallback"
  );
  const sourceResolved = inspectResolvedPackageSync(
    fsImpl,
    sourcePath ? path.join(sourcePath, "package.json") : null,
    "dependency-source"
  );
  const managedRoot = resolveManagedRoot(options);
  const visibleMarker = (profileResolved && profileResolved.clawdManifest)
    || (sourceResolved && sourceResolved.clawdManifest)
    || null;
  const managedGenerationResolved = visibleMarker && typeof visibleMarker.bundleHash === "string"
    ? inspectResolvedPackageSync(
      fsImpl,
      path.join(managedRoot, "generations", visibleMarker.bundleHash, "package.json"),
      "managed-generation"
    )
    : null;
  const verifyCurrentSource = options.verifyCurrentSource !== false;
  const expectedHashes = options.expectedHashes !== undefined
    ? options.expectedHashes
    : (verifyCurrentSource
      ? computeExpectedSourceHashesSync(fsImpl, options.sourceDir || resolveBridgeSourceDir(options.baseDir))
      : null);
  const health = classifyDeepSeekHarnessProfile({
    dshHome,
    profileDir,
    profileManifest,
    installationResolved,
    profileResolved,
    fallbackResolved,
    sourceResolved,
    managedGenerationResolved,
    sourcePath,
    managedRoot,
    expectedHashes,
    fs: fsImpl,
    platform: options.platform,
  });
  const sourceAwareHealth = verifyCurrentSource && !expectedHashes && health.owned
    ? { ...health, status: "source-unavailable" }
    : health;
  const immutableConflict = new Set([
    "profile-entry-foreign-or-conflicting",
    "generation-integrity-failed",
    "source-unavailable",
  ]).has(sourceAwareHealth.status);
  const compatibilityAwareHealth = detectedDshVersion
    && !isSupportedDshVersion(detectedDshVersion)
    && !immutableConflict
    ? { ...sourceAwareHealth, status: "host-version-unsupported" }
    : sourceAwareHealth;
  compatibilityAwareHealth.detectedDshVersion = detectedDshVersion;
  compatibilityAwareHealth.supportedDshRange = supportedDshRangeLabel();
  compatibilityAwareHealth.supportedDshVersions = DSH_VERSION_CONTRACTS.map((contract) => contract.version);
  const latch = readInspectionLatchSync(fsImpl, options);
  if (!latch) return compatibilityAwareHealth;
  const latchBlockedByHigherPriority = immutableConflict
    || compatibilityAwareHealth.status === "host-version-unsupported";
  return {
    ...compatibilityAwareHealth,
    status: latchBlockedByHigherPriority ? compatibilityAwareHealth.status : "inspection-required",
    inspectionLatch: latch,
  };
}

async function inspectDeepSeekHarnessIntegration(options = {}) {
  const dshHome = options.dshHome || resolveDshHome(options.env);
  const profileDir = resolveDshProfileDir(dshHome);
  const removalResidueHealth = managedProfileRemovalResidueHealth(
    await listManagedProfileRemovalResidues(options),
    options
  );
  if (removalResidueHealth) return removalResidueHealth;
  const profileManifestPath = path.join(profileDir, "package.json");
  const profileManifest = await readJson(profileManifestPath);
  if (!profileManifest) {
    return {
      status: await exists(profileManifestPath) ? "profile-corrupt" : "profile-missing",
      dshHome,
      profileDir,
      dependencyPresent: false,
      bundlePresent: false,
      owned: false,
      resolved: null,
    };
  }
  const dependencies = profileManifest.dependencies && typeof profileManifest.dependencies === "object"
    ? profileManifest.dependencies
    : {};
  const dependencySpec = dependencies[BRIDGE_PACKAGE_NAME] || null;
  const sourcePath = dependencySourcePath(dependencySpec, profileDir, options.platform || process.platform);

  let commandInfo = options.commandInfo || null;
  if (!commandInfo && options.resolveCommandForInspection !== false) {
    commandInfo = await resolveDshCommand(options);
  }
  const installationManifest = commandInfo && commandInfo.installRoot
    ? packagePath(commandInfo.installRoot, BRIDGE_PACKAGE_NAME)
    : null;
  const profilePackageManifest = packagePath(profileDir, BRIDGE_PACKAGE_NAME);
  const installationResolved = await inspectResolvedPackage(installationManifest, "installation");
  const profileResolved = await inspectResolvedPackage(profilePackageManifest, "profile");
  const fallbackResolved = await inspectResolvedPackage(
    packagePath(path.join(dshHome, "profiles"), BRIDGE_PACKAGE_NAME),
    "profiles-fallback"
  );
  const sourceResolved = await inspectResolvedPackage(
    sourcePath ? path.join(sourcePath, "package.json") : null,
    "dependency-source"
  );
  const managedRoot = resolveManagedRoot(options);
  const visibleMarker = (profileResolved && profileResolved.clawdManifest)
    || (sourceResolved && sourceResolved.clawdManifest)
    || null;
  const managedGenerationResolved = visibleMarker && typeof visibleMarker.bundleHash === "string"
    ? await inspectResolvedPackage(
      path.join(managedRoot, "generations", visibleMarker.bundleHash, "package.json"),
      "managed-generation"
    )
    : null;
  return classifyDeepSeekHarnessProfile({
    dshHome,
    profileDir,
    profileManifest,
    installationResolved,
    profileResolved,
    fallbackResolved,
    sourceResolved,
    managedGenerationResolved,
    sourcePath,
    managedRoot,
    expectedHashes: options.expectedHashes,
    platform: options.platform,
  });
}

async function readSourceBundle(options = {}) {
  const contract = options.contract || dshContractForVersion(options.dshVersion) || PREFERRED_DSH_CONTRACT;
  const sourceDir = options.sourceDir || resolveBridgeSourceDir(options.baseDir);
  const files = [];
  for (const relativePath of BRIDGE_SOURCE_FILES) {
    const filePath = path.join(sourceDir, ...relativePath.split("/"));
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`DSH bridge source must be a regular file: ${filePath}`);
    }
    files.push({ relativePath, content: await fsp.readFile(filePath) });
  }
  return { sourceDir, files, bundleHash: digestBridgeFiles(files, contract), contract };
}

async function sourceClawdVersion(options = {}) {
  if (typeof options.clawdVersion === "string" && options.clawdVersion.trim()) {
    return options.clawdVersion.trim();
  }
  const packageManifest = await readJson(path.join(__dirname, "..", "package.json"));
  return packageManifest && typeof packageManifest.version === "string"
    ? packageManifest.version
    : "0.0.0";
}

async function promoteGeneration(bundle, options = {}) {
  const contract = options.contract || dshContractForVersion(options.dshVersion) || bundle.contract || PREFERRED_DSH_CONTRACT;
  const managedRoot = resolveManagedRoot(options);
  const generationsDir = path.join(managedRoot, "generations");
  const generationDir = path.join(generationsDir, bundle.bundleHash);
  const version = await sourceClawdVersion(options);
  await fsp.mkdir(generationsDir, { recursive: true });
  const existing = await readJson(path.join(generationDir, MANIFEST_FILE));
  const existingContract = existing ? dshContractForMarker(existing) : null;
  const existingHash = existing && existingContract ? await hashBridgeDirectory(generationDir, existingContract) : null;
  if (
    existing
    && existing.owner === MANAGED_OWNER
    && existing.schemaVersion === MANIFEST_SCHEMA_VERSION
    && existing.protocolVersion === BRIDGE_PROTOCOL_VERSION
    && existing.bundleHash === bundle.bundleHash
    && existingContract
    && existingContract.version === contract.version
    && existingHash === bundle.bundleHash
  ) {
    return { managedRoot, generationDir, bundleHash: bundle.bundleHash, created: false, manifest: existing };
  }
  if (await exists(generationDir)) {
    throw new Error(`DSH generation path exists without a matching marker: ${generationDir}`);
  }
  const stagingDir = path.join(generationsDir, `.staging-${process.pid}-${crypto.randomUUID()}`);
  await fsp.mkdir(stagingDir, { recursive: false });
  try {
    for (const file of bundle.files) {
      const target = path.join(stagingDir, ...file.relativePath.split("/"));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, file.content, { flag: "wx" });
    }
    const manifest = {
      owner: MANAGED_OWNER,
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      packageName: BRIDGE_PACKAGE_NAME,
      bundleHash: bundle.bundleHash,
      sourceClawdVersion: version,
      supportedDshRange: contract.supportedDshRange,
      installedDshVersion: options.dshVersion || contract.version,
      installedDshVersionAssumedAtStaging: options.dshVersionAssumed === true,
      verifiedDshArtifact: contract.verifiedDshArtifact,
      verifiedDshArtifactIntegrity: contract.verifiedDshArtifactIntegrity,
      sourceAuditBaselineCommit: SOURCE_AUDIT_BASELINE_COMMIT,
      installedAt: new Date().toISOString(),
    };
    await fsp.writeFile(
      path.join(stagingDir, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 }
    );
    try {
      await fsp.rename(stagingDir, generationDir);
    } catch (err) {
      if (!err || (err.code !== "EEXIST" && err.code !== "ENOTEMPTY")) throw err;
      const raced = await readJson(path.join(generationDir, MANIFEST_FILE));
      const racedHash = raced ? await hashBridgeDirectory(generationDir, contract) : null;
      if (
        !raced
        || raced.owner !== MANAGED_OWNER
        || raced.bundleHash !== bundle.bundleHash
        || racedHash !== bundle.bundleHash
      ) throw err;
      await fsp.rm(stagingDir, { recursive: true, force: true });
      return { managedRoot, generationDir, bundleHash: bundle.bundleHash, created: false, manifest: raced };
    }
    return { managedRoot, generationDir, bundleHash: bundle.bundleHash, created: true, manifest };
  } catch (err) {
    if (path.resolve(stagingDir).startsWith(`${path.resolve(generationsDir)}${path.sep}`)) {
      try { await fsp.rm(stagingDir, { recursive: true, force: true }); } catch {}
    }
    throw err;
  }
}

function mutationLockOperationTimeoutMs(options = {}) {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return DEFAULT_OPERATION_TIMEOUT_MS;
  }
  const timeoutMs = Math.ceil(options.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > MAX_MUTATION_LOCK_OPERATION_TIMEOUT_MS) {
    throw new RangeError("DeepSeek Harness mutation timeout is outside the supported lock range");
  }
  return timeoutMs;
}

function mutationLockStaleMs(owner) {
  return owner.operationTimeoutMs * MUTATION_LOCK_STALE_MULTIPLIER;
}

function isValidMutationLockOwner(owner) {
  return !!(
    owner
    && owner.owner === MANAGED_OWNER
    && owner.schemaVersion === MUTATION_LOCK_SCHEMA_VERSION
    && typeof owner.token === "string"
    && owner.token.length > 0
    && owner.token.length <= 200
    && Number.isSafeInteger(owner.pid)
    && owner.pid > 0
    && Number.isSafeInteger(owner.operationTimeoutMs)
    && owner.operationTimeoutMs > 0
    && owner.operationTimeoutMs <= MAX_MUTATION_LOCK_OPERATION_TIMEOUT_MS
    && typeof owner.createdAt === "string"
    && Number.isFinite(Date.parse(owner.createdAt))
  );
}

function sameMutationLockOwner(left, right) {
  return isValidMutationLockOwner(left)
    && isValidMutationLockOwner(right)
    && left.owner === right.owner
    && left.schemaVersion === right.schemaVersion
    && left.token === right.token
    && left.pid === right.pid
    && left.operationTimeoutMs === right.operationTimeoutMs
    && left.createdAt === right.createdAt;
}

function mutationLockError(lockDir, owner, detail = "") {
  const pidDetail = owner && Number.isSafeInteger(owner.pid) ? ` (pid ${owner.pid})` : "";
  const suffix = detail ? `; ${detail}` : "";
  const err = new Error(
    `DeepSeek Harness integration mutation is already locked${pidDetail}; lock path: ${lockDir}${suffix}`
  );
  err.code = "DSH_MUTATION_LOCKED";
  err.lockPath = lockDir;
  return err;
}

function mutationLockProcessState(pid, options = {}) {
  const processKill = typeof options.processKill === "function"
    ? options.processKill
    : process.kill.bind(process);
  try {
    processKill(pid, 0);
    return "alive";
  } catch (err) {
    // ESRCH is the only portable proof that the recorded owner no longer
    // exists. EPERM and every unknown Windows error remain fail-closed.
    return err && err.code === "ESRCH" ? "dead" : "unknown";
  }
}

async function cleanupQuarantinedMutationLock(quarantineDir, expectedOwner) {
  try {
    const ownerPath = path.join(quarantineDir, "owner.json");
    const owner = await readJson(ownerPath);
    if (!sameMutationLockOwner(owner, expectedOwner)) return false;
    await fsp.unlink(ownerPath);
    await fsp.rmdir(quarantineDir);
    return true;
  } catch {
    // A quarantine sibling never blocks the canonical lock path. Do not use a
    // recursive fallback if unexpected contents appeared after the rename.
    return false;
  }
}

async function quarantineStaleMutationLock(lockDir, options = {}) {
  const owner = await readJson(path.join(lockDir, "owner.json"));
  if (!isValidMutationLockOwner(owner)) {
    if (!(await exists(lockDir))) return { retry: true, quarantineDir: null, owner: null };
    throw mutationLockError(lockDir, owner, "owner metadata is invalid; manual inspection required");
  }
  const nowMs = typeof options.nowMs === "function" ? options.nowMs() : Date.now();
  const createdAtMs = Date.parse(owner.createdAt);
  if (nowMs < createdAtMs || nowMs - createdAtMs < mutationLockStaleMs(owner)) {
    throw mutationLockError(lockDir, owner, "the lock has not exceeded its stale threshold");
  }
  const processState = mutationLockProcessState(owner.pid, options);
  if (processState !== "dead") {
    throw mutationLockError(
      lockDir,
      owner,
      processState === "alive" ? "the owner process is still alive" : "owner liveness is unknown"
    );
  }

  const quarantineDir = `${lockDir}.stale-${crypto.randomUUID()}`;
  try {
    await fsp.rename(lockDir, quarantineDir);
  } catch (err) {
    if (err && err.code === "ENOENT") return { retry: true, quarantineDir: null, owner: null };
    throw mutationLockError(lockDir, owner, "another process won the stale-lock takeover race");
  }
  const movedOwner = await readJson(path.join(quarantineDir, "owner.json"));
  if (!sameMutationLockOwner(movedOwner, owner)) {
    try { await fsp.rename(quarantineDir, lockDir); } catch {}
    throw mutationLockError(lockDir, movedOwner, "lock ownership changed during stale takeover");
  }
  return { retry: false, quarantineDir, owner };
}

async function acquireMutationLock(options = {}) {
  const managedRoot = resolveManagedRoot(options);
  const lockDir = path.join(managedRoot, "mutation.lock");
  const token = crypto.randomUUID();
  const operationTimeoutMs = mutationLockOperationTimeoutMs(options);
  let quarantined = null;
  await fsp.mkdir(managedRoot, { recursive: true });
  try {
    await fsp.mkdir(lockDir);
  } catch (err) {
    if (err && err.code === "EEXIST") {
      quarantined = await quarantineStaleMutationLock(lockDir, options);
      try {
        await fsp.mkdir(lockDir);
      } catch (retryErr) {
        if (quarantined.quarantineDir) {
          await cleanupQuarantinedMutationLock(quarantined.quarantineDir, quarantined.owner);
        }
        const owner = await readJson(path.join(lockDir, "owner.json"));
        throw mutationLockError(
          lockDir,
          owner,
          retryErr && retryErr.code === "EEXIST"
            ? "another process acquired the lock during recovery"
            : "the lock could not be recreated after recovery"
        );
      }
    } else {
      throw err;
    }
  }
  const expectedOwner = {
    owner: MANAGED_OWNER,
    schemaVersion: MUTATION_LOCK_SCHEMA_VERSION,
    token,
    pid: process.pid,
    operationTimeoutMs,
    createdAt: new Date().toISOString(),
  };
  try {
    if (options.__testMutationLockHooks && typeof options.__testMutationLockHooks.beforeOwnerWrite === "function") {
      await options.__testMutationLockHooks.beforeOwnerWrite({ lockDir, expectedOwner: { ...expectedOwner } });
    }
    await fsp.writeFile(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify(expectedOwner, null, 2)}\n`,
      { flag: "wx", mode: 0o600 }
    );
  } catch (err) {
    // Only an empty directory remains provably ours after an owner-file write
    // failure. Unexpected contents may have appeared concurrently, so never
    // recurse through the canonical lock path.
    try {
      await fsp.rmdir(lockDir);
      throw err;
    } catch (cleanupErr) {
      if (cleanupErr === err) throw err;
      const locked = mutationLockError(
        lockDir,
        await readJson(path.join(lockDir, "owner.json")),
        "owner metadata write failed and the lock is not empty; manual inspection required"
      );
      locked.cause = err;
      throw locked;
    }
  }
  if (quarantined && quarantined.quarantineDir) {
    await cleanupQuarantinedMutationLock(quarantined.quarantineDir, quarantined.owner);
  }
  return {
    lockPath: lockDir,
    async release() {
      const ownerPath = path.join(lockDir, "owner.json");
      const owner = await readJson(ownerPath);
      if (!sameMutationLockOwner(owner, expectedOwner)) {
        throw mutationLockError(lockDir, owner, "lock ownership changed; manual inspection required");
      }
      if (options.__testMutationLockHooks && typeof options.__testMutationLockHooks.beforeReleaseOwnerMove === "function") {
        await options.__testMutationLockHooks.beforeReleaseOwnerMove({ lockDir, expectedOwner: { ...expectedOwner } });
      }
      const releaseOwnerPath = path.join(lockDir, `owner.release-${token}.json`);
      try {
        await fsp.rename(ownerPath, releaseOwnerPath);
      } catch (err) {
        const locked = mutationLockError(lockDir, await readJson(ownerPath), "lock owner could not be isolated for release");
        locked.cause = err;
        throw locked;
      }
      const isolatedOwner = await readJson(releaseOwnerPath);
      if (!sameMutationLockOwner(isolatedOwner, expectedOwner)) {
        throw mutationLockError(lockDir, isolatedOwner, "lock ownership changed during release; manual inspection required");
      }
      try {
        await fsp.unlink(releaseOwnerPath);
        await fsp.rmdir(lockDir);
      } catch (err) {
        const locked = mutationLockError(
          lockDir,
          isolatedOwner,
          "unexpected lock contents prevented exact release; manual inspection required"
        );
        locked.cause = err;
        throw locked;
      }
    },
  };
}

function inspectionLatchPath(options = {}) {
  return path.join(resolveManagedRoot(options), "inspection-required.json");
}

async function readInspectionLatch(options = {}) {
  const filePath = inspectionLatchPath(options);
  if (!(await exists(filePath))) return null;
  const parsed = await readJson(filePath);
  return parsed || { invalid: true, reason: "inspection-latch-invalid" };
}

async function writeInspectionLatch(reason, detail, options = {}) {
  const filePath = inspectionLatchPath(options);
  const current = await readInspectionLatch(options);
  if (current && (current.invalid || current.owner !== MANAGED_OWNER || current.schemaVersion !== 1)) {
    throw new Error("DeepSeek Harness inspection latch ownership is invalid; manual inspection required");
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify({
    owner: MANAGED_OWNER,
    schemaVersion: 1,
    reason,
    detail: typeof detail === "string" ? detail.slice(0, 2000) : "",
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
}

async function clearInspectionLatch(options = {}) {
  const filePath = inspectionLatchPath(options);
  const current = await readJson(filePath);
  if (!current) return;
  if (current.owner !== MANAGED_OWNER || current.schemaVersion !== 1) {
    throw new Error("DeepSeek Harness inspection latch ownership is invalid; manual inspection required");
  }
  await fsp.rm(filePath, { force: false });
}

function manualGenerationReferencePath(options = {}) {
  return path.join(resolveManagedRoot(options), MANUAL_GENERATION_REFERENCE_FILE);
}

async function listManualGenerationReferenceResidues(options = {}) {
  const filePath = manualGenerationReferencePath(options);
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  try {
    const readdir = options.__testManualGenerationReferenceHooks
      && typeof options.__testManualGenerationReferenceHooks.readdirResidues === "function"
      ? options.__testManualGenerationReferenceHooks.readdirResidues
      : fsp.readdir.bind(fsp);
    const entries = await readdir(dir, { withFileTypes: true });
    return {
      paths: entries
      .filter((entry) => entry.name.startsWith(prefix))
      .map((entry) => path.join(dir, entry.name))
      .sort(),
      unreadableError: null,
    };
  } catch (err) {
    if (err && err.code === "ENOENT") return { paths: [], unreadableError: null };
    return { paths: [], unreadableError: err || new Error("manual reference directory is unreadable") };
  }
}

function isValidManualGenerationReference(reference) {
  return !!(
    reference
    && reference.owner === MANAGED_OWNER
    && reference.schemaVersion === MANUAL_GENERATION_REFERENCE_SCHEMA_VERSION
    && reference.packageName === BRIDGE_PACKAGE_NAME
    && typeof reference.bundleHash === "string"
    && /^[a-f0-9]{64}$/.test(reference.bundleHash)
    && reference.reason === "manual-npx-add"
    && typeof reference.createdAt === "string"
    && Number.isFinite(Date.parse(reference.createdAt))
  );
}

function sameManualGenerationReference(left, right) {
  return isValidManualGenerationReference(left)
    && isValidManualGenerationReference(right)
    && left.owner === right.owner
    && left.schemaVersion === right.schemaVersion
    && left.packageName === right.packageName
    && left.bundleHash === right.bundleHash
    && left.reason === right.reason
    && left.createdAt === right.createdAt;
}

async function readManualGenerationReference(options = {}) {
  const filePath = manualGenerationReferencePath(options);
  const scanBefore = await listManualGenerationReferenceResidues(options);
  if (scanBefore.unreadableError) {
    return {
      invalid: true,
      referencePath: path.dirname(filePath),
      reason: "reference-directory-unreadable",
    };
  }
  const residuesBefore = scanBefore.paths;
  let stat;
  try {
    stat = await fsp.lstat(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      if (residuesBefore.length) {
        return {
          invalid: true,
          referencePath: residuesBefore[0],
          residuePaths: residuesBefore,
          reason: "reference-residue",
        };
      }
      return null;
    }
    return { invalid: true, referencePath: filePath, reason: "reference-unreadable" };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { invalid: true, referencePath: filePath, reason: "reference-not-regular-file" };
  }
  const reference = await readJson(filePath);
  if (!isValidManualGenerationReference(reference)) {
    return { invalid: true, referencePath: filePath, reason: "reference-invalid" };
  }
  const scanAfter = await listManualGenerationReferenceResidues(options);
  if (scanAfter.unreadableError) {
    return {
      invalid: true,
      referencePath: path.dirname(filePath),
      reason: "reference-directory-unreadable",
    };
  }
  const residues = [...new Set([...residuesBefore, ...scanAfter.paths])];
  if (residues.length) {
    return {
      invalid: true,
      referencePath: residues[0],
      residuePaths: residues,
      reason: "reference-residue",
    };
  }
  return reference;
}

function manualGenerationReferenceError(reference, options = {}) {
  const filePath = reference && reference.referencePath
    ? reference.referencePath
    : manualGenerationReferencePath(options);
  const err = new Error(
    `DeepSeek Harness manual generation reference is invalid; manual inspection required: ${filePath}`
  );
  err.code = "DSH_MANUAL_GENERATION_REFERENCE_INVALID";
  err.referencePath = filePath;
  return err;
}

function manualGenerationReferenceResult(reference, options = {}) {
  const err = manualGenerationReferenceError(reference, options);
  return {
    status: "error",
    reason: "manual-generation-reference-invalid",
    message: err.message,
    referencePath: err.referencePath,
    manualInspectionRequired: true,
  };
}

async function writeManualGenerationReference(generation, options = {}) {
  const managedRoot = resolveManagedRoot(options);
  const expectedGeneration = path.join(managedRoot, "generations", generation.bundleHash);
  if (!sameResolvedPath(generation.generationDir, expectedGeneration, options.platform)) {
    throw new Error("Refusing to reference a manual DSH generation outside the managed namespace");
  }
  const marker = await readJson(path.join(expectedGeneration, MANIFEST_FILE));
  const markerContract = dshContractForMarker(marker);
  const actualHash = markerContract
    ? await hashBridgeDirectory(expectedGeneration, markerContract)
    : null;
  if (
    !marker
    || !markerContract
    || marker.owner !== MANAGED_OWNER
    || marker.bundleHash !== generation.bundleHash
    || actualHash !== generation.bundleHash
  ) {
    throw new Error("Refusing to reference a manual DSH generation whose marker or bytes are invalid");
  }
  const filePath = manualGenerationReferencePath(options);
  const existing = await readManualGenerationReference(options);
  if (existing && existing.invalid) throw manualGenerationReferenceError(existing, options);
  if (existing) {
    if (existing.bundleHash === generation.bundleHash) return false;
    const err = new Error(
      `A different DeepSeek Harness manual generation is still referenced; inspect it before replacement: ${filePath}`
    );
    err.code = "DSH_MANUAL_GENERATION_REFERENCE_ACTIVE";
    err.referencePath = filePath;
    throw err;
  }
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fsp.writeFile(tempPath, `${JSON.stringify({
      owner: MANAGED_OWNER,
      schemaVersion: MANUAL_GENERATION_REFERENCE_SCHEMA_VERSION,
      packageName: BRIDGE_PACKAGE_NAME,
      bundleHash: generation.bundleHash,
      reason: "manual-npx-add",
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    try {
      // Linking the completed temp file into the canonical name is an atomic
      // create-if-absent operation on the same filesystem. A concurrent or
      // malformed anchor is never overwritten (POSIX rename would overwrite).
      await fsp.link(tempPath, filePath);
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      const raced = await readManualGenerationReference(options);
      if (raced && !raced.invalid && raced.bundleHash === generation.bundleHash) return false;
      if (raced && raced.invalid) throw manualGenerationReferenceError(raced, options);
      const conflict = new Error(
        `A different DeepSeek Harness manual generation reference appeared concurrently: ${filePath}`
      );
      conflict.code = "DSH_MANUAL_GENERATION_REFERENCE_ACTIVE";
      conflict.referencePath = filePath;
      throw conflict;
    }
    return true;
  } catch (err) {
    throw err;
  } finally {
    try { await fsp.unlink(tempPath); } catch {}
  }
}

async function clearManualGenerationReference(options = {}) {
  const filePath = manualGenerationReferencePath(options);
  const reference = await readManualGenerationReference(options);
  if (!reference) return false;
  if (reference.invalid) throw manualGenerationReferenceError(reference, options);
  if (
    options.__testManualGenerationReferenceHooks
    && typeof options.__testManualGenerationReferenceHooks.beforeClearMove === "function"
  ) {
    await options.__testManualGenerationReferenceHooks.beforeClearMove({ filePath, reference: { ...reference } });
  }
  const isolatedPath = `${filePath}.clearing-${crypto.randomUUID()}`;
  try {
    await fsp.rename(filePath, isolatedPath);
  } catch (err) {
    const changed = manualGenerationReferenceError(
      { referencePath: filePath },
      options
    );
    changed.message = `DeepSeek Harness manual generation reference changed before cleanup; manual inspection required: ${filePath}`;
    changed.cause = err;
    throw changed;
  }
  const isolated = await readJson(isolatedPath);
  if (!sameManualGenerationReference(isolated, reference)) {
    try {
      if (
        options.__testManualGenerationReferenceHooks
        && typeof options.__testManualGenerationReferenceHooks.beforeRestore === "function"
      ) {
        await options.__testManualGenerationReferenceHooks.beforeRestore({
          filePath,
          isolatedPath,
          reference: isolated,
        });
      }
      await fsp.link(isolatedPath, filePath);
      await fsp.unlink(isolatedPath);
    } catch {}
    const changed = manualGenerationReferenceError({ referencePath: filePath }, options);
    changed.message = `DeepSeek Harness manual generation reference changed during cleanup; manual inspection required: ${filePath}`;
    throw changed;
  }
  if (
    options.__testManualGenerationReferenceHooks
    && typeof options.__testManualGenerationReferenceHooks.afterClearMove === "function"
  ) {
    await options.__testManualGenerationReferenceHooks.afterClearMove({
      filePath,
      isolatedPath,
      reference: { ...reference },
    });
  }
  try {
    if (
      options.__testManualGenerationReferenceHooks
      && typeof options.__testManualGenerationReferenceHooks.beforeIsolatedUnlink === "function"
    ) {
      await options.__testManualGenerationReferenceHooks.beforeIsolatedUnlink({
        filePath,
        isolatedPath,
        reference: isolated,
      });
    }
    await fsp.unlink(isolatedPath);
  } catch (err) {
    const changed = manualGenerationReferenceError({ referencePath: isolatedPath }, options);
    changed.message = `DeepSeek Harness manual generation reference residue could not be removed; manual inspection required: ${isolatedPath}`;
    changed.cause = err;
    throw changed;
  }
  const replacement = await readManualGenerationReference(options);
  if (replacement) {
    const changed = manualGenerationReferenceError(
      { referencePath: filePath },
      options
    );
    changed.message = `A new DeepSeek Harness manual generation reference appeared during cleanup; manual inspection required: ${filePath}`;
    throw changed;
  }
  return true;
}

function inspectionLatchResult(latch) {
  return {
    status: "error",
    reason: "inspection-required",
    message: latch && latch.invalid
      ? "The DeepSeek Harness inspection latch is invalid; inspect the managed integration before retrying"
      : "A previous DeepSeek Harness plugin mutation had an unknown result; use explicit Repair or Uninstall after inspecting the profile",
    manualInspectionRequired: true,
  };
}

function isUnknownCommandResult(result) {
  return !!(result && (result.timedOut || result.signal || result.outputLimited));
}

function hasMutableManagedState(health) {
  if (!health) return false;
  if (health.status === "absent" || health.status === "profile-missing") return true;
  if (!health.owned || !health.marker) return false;
  return new Set([
    "healthy",
    "generation-mismatch",
    "version-unsupported",
    "profile-entry-incomplete",
    "managed-bundle-missing",
    "managed-residue",
  ]).has(health.status);
}

function sameResolvedPath(left, right, platform = process.platform) {
  if (!left || !right) return false;
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function unlinkManagedProfileResidue(health, options = {}) {
  if (
    !health
    || health.status !== "managed-residue"
    || health.dependencyPresent
    || health.bundlePresent
    || health.installationResolved
    || !health.profileResolved
    || !health.marker
    || !isIntactManaged(health.profileResolved)
  ) {
    return { removed: false, reason: "not-exact-managed-residue" };
  }
  const managedRoot = resolveManagedRoot(options);
  const expectedGeneration = path.join(
    managedRoot,
    "generations",
    health.marker.bundleHash
  );
  if (
    !isManagedGenerationRecord(health.profileResolved, managedRoot, options)
    || !sameResolvedPath(health.profileResolved.packageDir, expectedGeneration, options.platform)
  ) {
    return { removed: false, reason: "residue-target-mismatch" };
  }
  const profileDir = health.profileDir || resolveDshProfileDir(
    options.dshHome || resolveDshHome(options.env)
  );
  const linkDir = path.dirname(packagePath(profileDir, BRIDGE_PACKAGE_NAME));
  let stat;
  let realTarget;
  try {
    stat = await fsp.lstat(linkDir);
    if (!stat.isSymbolicLink()) {
      return { removed: false, reason: "residue-not-link" };
    }
    realTarget = await fsp.realpath(linkDir);
  } catch (err) {
    return { removed: false, reason: "residue-inspection-failed", error: err };
  }
  if (!sameResolvedPath(realTarget, expectedGeneration, options.platform)) {
    return { removed: false, reason: "residue-link-target-mismatch" };
  }
  if (
    options.__testManagedProfileResidueHooks
    && typeof options.__testManagedProfileResidueHooks.beforeIsolateMove === "function"
  ) {
    await options.__testManagedProfileResidueHooks.beforeIsolateMove({
      linkDir,
      expectedGeneration,
    });
  }
  const isolatedPath = `${linkDir}.clawd-removing-${crypto.randomUUID()}`;
  try {
    await fsp.rename(linkDir, isolatedPath);
  } catch (err) {
    return { removed: false, reason: "residue-isolation-failed", error: err };
  }
  let isolatedStat;
  let isolatedTarget;
  try {
    isolatedStat = await fsp.lstat(isolatedPath);
    isolatedTarget = await fsp.realpath(isolatedPath);
  } catch (err) {
    return {
      removed: false,
      reason: "residue-isolation-inspection-failed",
      residuePath: isolatedPath,
      error: err,
    };
  }
  if (!isolatedStat.isSymbolicLink() || !sameResolvedPath(
    isolatedTarget,
    expectedGeneration,
    options.platform
  )) {
    const restored = await restoreIsolatedProfileSymlink(isolatedPath, linkDir, options);
    return {
      removed: false,
      reason: restored ? "residue-target-changed" : "residue-isolation-changed",
      residuePath: restored ? null : isolatedPath,
    };
  }
  try {
    const unlink = options.unlinkManagedProfileLink || fsp.unlink.bind(fsp);
    await unlink(isolatedPath);
  } catch (err) {
    const restored = await restoreIsolatedProfileSymlink(isolatedPath, linkDir, options);
    return {
      removed: false,
      reason: restored ? "residue-unlink-failed" : "residue-unlink-restore-failed",
      residuePath: restored ? null : isolatedPath,
      error: err,
    };
  }
  return { removed: true, linkDir };
}

async function restoreIsolatedProfileSymlink(isolatedPath, linkDir, options = {}) {
  let target;
  try {
    target = await fsp.readlink(isolatedPath);
  } catch {
    return false;
  }
  try {
    await fsp.symlink(
      target,
      linkDir,
      (options.platform || process.platform) === "win32" ? "junction" : undefined
    );
  } catch {
    return false;
  }
  try {
    await fsp.unlink(isolatedPath);
    return true;
  } catch {
    return false;
  }
}

async function cleanLockedManagedProfileResidue(locked, commandInfo, lockedLatch, options = {}) {
  const cleanup = await unlinkManagedProfileResidue(locked, options);
  if (!cleanup.removed) {
    await writeInspectionLatch("plugin-remove-residue-cleanup-failed", cleanup.reason, options);
    return {
      status: "error",
      reason: "inspection-required",
      healthReason: locked.status,
      cleanupReason: cleanup.reason,
      residuePath: cleanup.residuePath || null,
      message: "The DSH profile retains a managed package link that could not be safely removed",
      manualInspectionRequired: true,
    };
  }
  const recovered = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
  if (recovered.status !== "absent" && recovered.status !== "profile-missing") {
    await writeInspectionLatch("plugin-remove-verification-failed", recovered.status, options);
    return {
      status: "error",
      reason: "inspection-required",
      healthReason: recovered.status,
      message: "The DSH profile still resolves the managed bridge after exact link cleanup",
      manualInspectionRequired: true,
    };
  }
  await clearManualGenerationReference(options);
  await cleanUnreferencedGenerations(null, options);
  if (lockedLatch) await clearInspectionLatch(options);
  return { status: "ok", removed: true, updated: true };
}

function healthFingerprint(health) {
  if (!health) return "missing";
  return JSON.stringify({
    status: health.status,
    dependencySpec: health.dependencySpec || null,
    dependencyPresent: health.dependencyPresent === true,
    bundlePresent: health.bundlePresent === true,
    markerHash: health.marker && health.marker.bundleHash || null,
    resolvedAnchor: health.resolved && health.resolved.anchor || null,
  });
}

function enqueueMutation(operation) {
  const run = mutationTail.then(operation, operation);
  mutationTail = run.catch(() => {});
  return run;
}

function compareVersions(left, right) {
  const parse = (value) => String(value || "").match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) || null;
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

async function cleanUnreferencedGenerations(activeHash, options = {}) {
  const removalResidues = await listManagedProfileRemovalResidues(options);
  if (removalResidues.unreadableError || removalResidues.paths.length) return;
  const generationsDir = path.join(resolveManagedRoot(options), "generations");
  let entries;
  try {
    entries = await fsp.readdir(generationsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === activeHash || entry.name.startsWith(".staging-")) continue;
    const candidate = path.join(generationsDir, entry.name);
    const marker = await readJson(path.join(candidate, MANIFEST_FILE));
    if (!marker || marker.owner !== MANAGED_OWNER || marker.bundleHash !== entry.name) continue;
    if (await isGenerationReferenced(candidate, options)) continue;
    await fsp.rm(candidate, { recursive: true, force: false });
  }
}

function isPathWithin(candidate, parent) {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedParent = path.resolve(parent);
  return normalizedCandidate === normalizedParent
    || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
}

async function isGenerationReferenced(generationDir, options = {}) {
  const removalResidues = await listManagedProfileRemovalResidues(options);
  if (removalResidues.unreadableError || removalResidues.paths.length) return true;
  const manualReference = await readManualGenerationReference(options);
  // An invalid anchor has lost the information needed to identify its one
  // protected generation. Conservatively retain every generation until the
  // user inspects the exact reference path.
  if (manualReference && manualReference.invalid) return true;
  if (
    isValidManualGenerationReference(manualReference)
    && manualReference.bundleHash === path.basename(generationDir)
    && sameResolvedPath(
      generationDir,
      path.join(resolveManagedRoot(options), "generations", manualReference.bundleHash),
      options.platform
    )
  ) return true;
  const dshHome = options.dshHome || resolveDshHome(options.env);
  const profilesDir = path.join(dshHome, "profiles");
  let profiles = [];
  try {
    profiles = await fsp.readdir(profilesDir, { withFileTypes: true });
  } catch {}
  for (const profile of profiles) {
    if (!profile.isDirectory() || profile.name === "node_modules") continue;
    const profileDir = path.join(profilesDir, profile.name);
    const manifest = await readJson(path.join(profileDir, "package.json"));
    const spec = manifest
      && manifest.dependencies
      && manifest.dependencies[BRIDGE_PACKAGE_NAME];
    const sourcePath = dependencySourcePath(spec, profileDir);
    if (sourcePath && isPathWithin(sourcePath, generationDir)) return true;
    const materialized = await inspectResolvedPackage(
      packagePath(profileDir, BRIDGE_PACKAGE_NAME),
      "reference-check"
    );
    if (
      isIntactManaged(materialized)
      && materialized.clawdManifest.bundleHash === path.basename(generationDir)
    ) return true;
  }
  // The shared profiles/node_modules tree is DSH's application dependency
  // closure, not a Clawd ownership anchor. A flat fallback must not retain a
  // generation after the real profile reference is gone.
  for (const root of [resolveDshProfileDir(dshHome)]) {
    const manifestPath = packagePath(root, BRIDGE_PACKAGE_NAME);
    try {
      const realPackageDir = path.dirname(await fsp.realpath(manifestPath));
      if (isPathWithin(realPackageDir, generationDir)) return true;
    } catch {}
    const materialized = await inspectResolvedPackage(manifestPath, "reference-check");
    if (
      isIntactManaged(materialized)
      && materialized.clawdManifest.bundleHash === path.basename(generationDir)
    ) return true;
  }
  return false;
}

async function discardCreatedGenerationIfUnreferenced(generation, _health, options = {}) {
  if (!generation || generation.created !== true) return;
  const generationsDir = path.join(resolveManagedRoot(options), "generations");
  const candidate = path.resolve(generation.generationDir);
  if (!candidate.startsWith(`${path.resolve(generationsDir)}${path.sep}`)) return;
  const marker = await readJson(path.join(candidate, MANIFEST_FILE));
  if (!marker || marker.owner !== MANAGED_OWNER || marker.bundleHash !== generation.bundleHash) return;
  // Inspect the exact generation rather than trusting a health record that may
  // describe the previous managed version. A manifest row referencing this
  // candidate counts even when pnpm did not materialize the package yet.
  if (await isGenerationReferenced(candidate, options)) return;
  await fsp.rm(candidate, { recursive: true, force: false });
}

/**
 * Sync the machine-level registration.
 *
 * This route never invokes the CLI, so it works on a desktop-app-only machine.
 * The version gate still runs whenever a CLI exists to probe; a host that
 * cannot be probed records an assumed contract, the same trade the no-CLI
 * manual path already makes.
 */
async function syncHomePatchRegistration(options = {}) {
  const operation = options.operation || "install";
  const dshHome = resolveCanonicalDshHome(options);
  const commandInfo = await resolveDshCommand(options);
  const probedVersion = commandInfo ? await readDshVersion(commandInfo, options) : null;
  const contract = probedVersion ? dshContractForVersion(probedVersion) : PREFERRED_DSH_CONTRACT;
  if (probedVersion && !contract) {
    return {
      status: "error",
      reason: "version-unsupported",
      message: `DeepSeek Harness ${probedVersion} is unsupported; this bridge supports ${supportedDshRangeLabel()}`,
      detectedVersion: probedVersion,
      supportedRange: supportedDshRangeLabel(),
    };
  }
  const lock = await acquireMutationLock(options);
  try {
    const result = await registerHomePatchBridge({
      ...options,
      dshHome,
      operation,
      contract,
      dshVersion: probedVersion || contract.version,
      dshVersionAssumed: !probedVersion,
    });
    if (result.status !== "ok") return result;
    return {
      ...result,
      operation,
      detectedVersion: probedVersion,
      supportedRange: supportedDshRangeLabel(),
    };
  } finally {
    await lock.release();
  }
}

async function syncDeepSeekHarnessIntegration(options = {}) {
  options = freezeDshOperationOptions(options);
  const operation = options.operation || "install";
  const silent = options.silent === true;
  try {
    return await enqueueMutation(async () => {
    const removalResidueHealth = managedProfileRemovalResidueHealth(
      await listManagedProfileRemovalResidues(options),
      options
    );
    if (removalResidueHealth) return managedProfileRemovalResidueResult(removalResidueHealth);
    const latch = await readInspectionLatch(options);
    if (latch && operation === "startup-sync") return inspectionLatchResult(latch);
    // The Electron desktop app reserves its own profile and refuses the CLI, so
    // once it is present the machine-level home patch is the only route that
    // reaches it — and that route reaches every other profile too. It is taken
    // before the CLI probe because a desktop-only machine has no CLI to probe.
    if (await isDesktopTargetPresent(options)) {
      return await syncHomePatchRegistration({ ...options, operation });
    }
    if (!(await isDshInstalled(options))) {
      return { status: "skipped", reason: "dsh-not-found", message: "DeepSeek Harness is not installed" };
    }
    const profileDir = resolveDshProfileDir(options.dshHome || resolveDshHome(options.env));
    if (operation === "startup-sync" && !(await exists(path.join(profileDir, "package.json")))) {
      return {
        status: "error",
        reason: "repair-required",
        message: "DeepSeek Harness web profile is missing; use Settings Repair to initialize it",
      };
    }
    const commandInfo = await resolveDshCommand(options);
    const before = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
    const currentVersion = await sourceClawdVersion(options);
    const manualReference = await readManualGenerationReference(options);
    if (manualReference && manualReference.invalid) {
      return manualGenerationReferenceResult(manualReference, options);
    }
    if (!hasMutableManagedState(before)) {
      return {
        status: "error",
        reason: before.status || "ownership-not-proven",
        message: before.status === "generation-integrity-failed"
          ? "The managed DSH bridge bytes no longer match their ownership marker; manual inspection is required"
          : (before.status === "profile-corrupt"
            ? "The DeepSeek Harness web profile manifest is unreadable; Clawd will not rewrite it automatically"
            : "A foreign or conflicting DSH plugin uses the Clawd package name"),
        manualInspectionRequired: true,
      };
    }
    if (!commandInfo) {
      const markerContract = before.marker ? dshContractForMarker(before.marker) : null;
      if (before.marker && !markerContract) {
        return {
          status: "error",
          reason: "version-unsupported",
          message: `The installed DeepSeek Harness marker targets ${before.marker.installedDshVersion || "an unknown version"}; refusing to stage a manual install for an unlisted contract`,
          detectedVersion: before.marker.installedDshVersion || null,
          supportedRange: supportedDshRangeLabel(),
          manualInspectionRequired: true,
        };
      }
      const noCliContract = markerContract || PREFERRED_DSH_CONTRACT;
      const bundle = await readSourceBundle({ ...options, contract: noCliContract });
      if (before.status === "healthy" && before.marker.bundleHash === bundle.bundleHash) {
        if (latch) return inspectionLatchResult(latch);
        if (manualReference) {
          const lock = await acquireMutationLock(options);
          try {
            const locked = await inspectDeepSeekHarnessIntegration({
              ...options,
              commandInfo: null,
              resolveCommandForInspection: false,
            });
            if (locked.status !== "healthy" || locked.marker.bundleHash !== bundle.bundleHash) {
              return {
                status: "error",
                reason: "ownership-changed",
                message: "DSH plugin state changed while finalizing a manual generation reference",
                manualInspectionRequired: true,
              };
            }
            await clearManualGenerationReference(options);
            await cleanUnreferencedGenerations(locked.marker.bundleHash, options);
            return { status: "ok", updated: false, health: locked, message: DSH_RESTART_HINT };
          } finally {
            await lock.release();
          }
        }
        return { status: "ok", updated: false, health: before, message: DSH_RESTART_HINT };
      }
      if (operation !== "startup-sync") {
        const lock = await acquireMutationLock(options);
        try {
          const locked = await inspectDeepSeekHarnessIntegration({
            ...options,
            commandInfo: null,
            resolveCommandForInspection: false,
          });
          if (!hasMutableManagedState(locked)) {
            return {
              status: "error",
              reason: locked.status || "ownership-changed",
              message: "DSH plugin ownership changed before staging the manual install generation",
              manualInspectionRequired: true,
            };
          }
          const lockedContract = locked.marker ? dshContractForMarker(locked.marker) : null;
          if (
            (before.marker && (!lockedContract || lockedContract.version !== noCliContract.version))
            || (!before.marker && locked.marker)
          ) {
            return {
              status: "error",
              reason: "ownership-changed",
              message: "DSH marker contract changed before staging the manual install generation",
              manualInspectionRequired: true,
            };
          }
          const generation = await promoteGeneration(bundle, {
            ...options,
            contract: noCliContract,
            dshVersion: noCliContract.version,
            dshVersionAssumed: true,
          });
          await writeManualGenerationReference(generation, options);
          await cleanUnreferencedGenerations(generation.bundleHash, options);
          return {
            status: "error",
            reason: "cli-unavailable",
            message: "DeepSeek Harness was detected, but a global dsh CLI is not available",
            manualCommand: buildManualDshCommand([
              "npx",
              `@deepseek-ai/dsh@${noCliContract.version}`,
              "plugin",
              "--profile",
              WEB_PROFILE_NAME,
              "add",
              generation.generationDir,
            ], options),
            manualGenerationReferenced: true,
          };
        } finally {
          await lock.release();
        }
      }
      return { status: "error", reason: "cli-unavailable", message: "DeepSeek Harness CLI is not available" };
    }
    const dshVersion = await readDshVersion(commandInfo, options);
    const contract = dshContractForVersion(dshVersion);
    const bundle = await readSourceBundle({ ...options, contract });
    if (!contract) {
      return {
        status: "error",
        reason: "version-unsupported",
        message: `DeepSeek Harness ${dshVersion || "unknown"} is unsupported; this bridge supports ${supportedDshRangeLabel()}`,
        detectedVersion: dshVersion,
        supportedRange: supportedDshRangeLabel(),
      };
    }
    if (
      !latch
      && !manualReference
      && before.status === "healthy"
      && before.marker.bundleHash === bundle.bundleHash
    ) {
      return { status: "ok", updated: false, health: before, message: DSH_RESTART_HINT };
    }
    if (before.owned && before.marker && before.marker.bundleHash !== bundle.bundleHash) {
      const order = compareVersions(before.marker.sourceClawdVersion, currentVersion);
      if (order === 1) {
        return { status: "skipped", reason: "newer-managed-generation", message: "A newer Clawd bridge generation is already installed" };
      }
      if ((order === 0 || order === null) && operation === "startup-sync") {
        return { status: "error", reason: "generation-conflict", message: "Managed DSH bridge version/hash conflict requires explicit inspection" };
      }
    }

    const lock = await acquireMutationLock(options);
    try {
      const locked = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
      const lockedVersion = await readDshVersion(commandInfo, options);
      if (!isSupportedDshVersion(lockedVersion)) {
        return {
          status: "error",
          reason: "version-unsupported",
          message: `DeepSeek Harness ${lockedVersion || "unknown"} is unsupported; this bridge supports ${supportedDshRangeLabel()}`,
          detectedVersion: lockedVersion,
          supportedRange: supportedDshRangeLabel(),
        };
      }
      if (lockedVersion !== contract.version) {
        return {
          status: "error",
          reason: "version-changed",
          message: `DeepSeek Harness changed from ${contract.version} to ${lockedVersion} before mutation; retry after the host version is stable`,
          detectedVersion: lockedVersion,
          expectedVersion: contract.version,
          supportedRange: supportedDshRangeLabel(),
        };
      }
      if (!hasMutableManagedState(locked)) {
        return {
          status: "error",
          reason: locked.status || "ownership-changed",
          message: "DSH plugin ownership or managed bytes changed before mutation",
          manualInspectionRequired: true,
        };
      }
      const lockedLatch = await readInspectionLatch(options);
      if (locked.status === "healthy" && locked.marker.bundleHash === bundle.bundleHash) {
        if (manualReference) {
          await clearManualGenerationReference(options);
          await cleanUnreferencedGenerations(locked.marker.bundleHash, options);
        }
        if (lockedLatch) await clearInspectionLatch(options);
        return { status: "ok", updated: false, health: locked, message: DSH_RESTART_HINT };
      }
      const pnpmRuntime = await resolvePnpmRuntime(commandInfo, options);
      if (!pnpmRuntime.available) {
        return { status: "error", reason: "pnpm-unavailable", message: "pnpm is required by dsh plugin add" };
      }
      if (locked.owned && locked.marker) {
        const lockedOrder = compareVersions(locked.marker.sourceClawdVersion, currentVersion);
        if (lockedOrder === 1) {
          return { status: "skipped", reason: "newer-managed-generation", message: "A newer Clawd bridge generation is already installed" };
        }
        if ((lockedOrder === 0 || lockedOrder === null) && operation === "startup-sync") {
          return { status: "error", reason: "generation-conflict", message: "Managed DSH bridge version/hash conflict requires explicit inspection" };
        }
      }
      const generation = await promoteGeneration(bundle, { ...options, contract, dshVersion });
      const result = await runDshCommand([
        "plugin", "--profile", WEB_PROFILE_NAME, "add", generation.generationDir,
      ], { ...options, commandInfo: pnpmRuntime.commandInfo });
      if (result.code !== 0) {
        const failedHealth = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
        const unknown = isUnknownCommandResult(result);
        const changed = healthFingerprint(failedHealth) !== healthFingerprint(locked);
        if (unknown || changed) {
          await writeInspectionLatch(
            unknown ? "plugin-add-unknown" : "plugin-add-partial-mutation",
            (result.stderr || result.stdout || "dsh plugin add failed").trim(),
            options
          );
          return {
            status: "error",
            reason: "inspection-required",
            message: (result.stderr || result.stdout || "dsh plugin add had an unknown or partial result").trim(),
            manualCommand: buildManualDshCommand([
              "dsh", "plugin", "--profile", WEB_PROFILE_NAME, "add", generation.generationDir,
            ], options),
            manualInspectionRequired: true,
          };
        }
        await discardCreatedGenerationIfUnreferenced(generation, failedHealth, options);
        return {
          status: "error",
          reason: "plugin-add-failed",
          message: (result.stderr || result.stdout || "dsh plugin add failed").trim(),
          manualCommand: buildManualDshCommand([
            "dsh", "plugin", "--profile", WEB_PROFILE_NAME, "add", generation.generationDir,
          ], options),
        };
      }
      const after = await inspectDeepSeekHarnessIntegration({
        ...options,
        commandInfo,
        expectedHashes: { [contract.version]: generation.bundleHash },
      });
      if (after.status !== "healthy") {
        await writeInspectionLatch("plugin-add-verification-failed", after.status, options);
        return {
          status: "error",
          reason: "inspection-required",
          healthReason: after.status,
          message: "dsh plugin add completed but the managed bridge did not verify healthy",
          manualInspectionRequired: true,
        };
      }
      await clearManualGenerationReference(options);
      await cleanUnreferencedGenerations(generation.bundleHash, options);
      if (lockedLatch) await clearInspectionLatch(options);
      if (!silent) console.log(`Clawd: DeepSeek Harness bridge ready (${generation.bundleHash.slice(0, 12)})`);
      return {
        status: "ok",
        updated: true,
        generation: generation.generationDir,
        health: after,
        message: DSH_RESTART_HINT,
      };
    } finally {
      await lock.release();
    }
    });
  } catch (err) {
    if (err && err.code === "DSH_MANUAL_GENERATION_REFERENCE_INVALID") {
      return manualGenerationReferenceResult({ referencePath: err.referencePath }, options);
    }
    throw err;
  }
}

async function uninstallDeepSeekHarnessBridge(options = {}) {
  options = freezeDshOperationOptions(options);
  try {
    return await enqueueMutation(async () => {
    const removalResidueHealth = managedProfileRemovalResidueHealth(
      await listManagedProfileRemovalResidues(options),
      options
    );
    if (removalResidueHealth) return managedProfileRemovalResidueResult(removalResidueHealth);
    const latch = await readInspectionLatch(options);
    const manualReference = await readManualGenerationReference(options);
    if (manualReference && manualReference.invalid) {
      return manualGenerationReferenceResult(manualReference, options);
    }
    const commandInfo = await resolveDshCommand(options);
    const before = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
    if (before.status === "absent" || before.status === "profile-missing") {
      if (!latch) {
        const lock = await acquireMutationLock(options);
        try {
          const locked = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
          if (locked.status !== "absent" && locked.status !== "profile-missing") {
            return {
              status: "error",
              reason: "ownership-changed",
              message: "DSH plugin state changed while cleaning unreferenced managed generations",
              manualInspectionRequired: true,
            };
          }
          await clearManualGenerationReference(options);
          await cleanUnreferencedGenerations(null, options);
          return { status: "skipped", reason: "bridge-not-installed" };
        } finally {
          await lock.release();
        }
      }
      if (!commandInfo) return inspectionLatchResult(latch);
      const dshVersion = await readDshVersion(commandInfo, options);
      if (!isSupportedDshVersion(dshVersion)) {
        return {
          status: "error",
          reason: "version-unsupported",
          message: `DeepSeek Harness ${dshVersion || "unknown"} is unsupported; refusing to clear removal state (supported: ${supportedDshRangeLabel()})`,
          detectedVersion: dshVersion,
          supportedRange: supportedDshRangeLabel(),
          manualInspectionRequired: true,
        };
      }
      const lock = await acquireMutationLock(options);
      try {
        const locked = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
        const lockedVersion = await readDshVersion(commandInfo, options);
        if (!isSupportedDshVersion(lockedVersion)) {
          return {
            status: "error",
            reason: "version-unsupported",
            message: `DeepSeek Harness ${lockedVersion || "unknown"} is unsupported; refusing to clear removal state (supported: ${supportedDshRangeLabel()})`,
            detectedVersion: lockedVersion,
            supportedRange: supportedDshRangeLabel(),
            manualInspectionRequired: true,
          };
        }
        if (locked.status !== "absent" && locked.status !== "profile-missing") {
          return {
            status: "error",
            reason: "ownership-changed",
            message: "DSH plugin state changed while verifying a previous removal",
            manualInspectionRequired: true,
          };
        }
        const lockedLatch = await readInspectionLatch(options);
        await clearManualGenerationReference(options);
        await cleanUnreferencedGenerations(null, options);
        if (lockedLatch) await clearInspectionLatch(options);
        return { status: "skipped", reason: "bridge-not-installed" };
      } finally {
        await lock.release();
      }
    }
    if (!hasMutableManagedState(before) || !before.owned || !before.marker) {
      return {
        status: "error",
        reason: "ownership-not-proven",
        message: "Refusing to remove a DSH plugin whose Clawd ownership is not fully verified",
      };
    }
    if (!commandInfo) {
      const removalContract = dshContractForMarker(before.marker);
      if (!removalContract) {
        return {
          status: "error",
          reason: "version-unsupported",
          message: `The installed DeepSeek Harness marker targets ${before.marker.installedDshVersion || "an unknown version"}; refusing to build a manual uninstall command for an unlisted contract`,
          detectedVersion: before.marker.installedDshVersion || null,
          supportedRange: supportedDshRangeLabel(),
          manualInspectionRequired: true,
        };
      }
      if (before.status === "managed-residue") {
        const lock = await acquireMutationLock(options);
        try {
          const locked = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
          if (
            locked.status !== "managed-residue"
            || !hasMutableManagedState(locked)
            || !locked.owned
            || !locked.marker
            || locked.marker.bundleHash !== before.marker.bundleHash
          ) {
            return {
              status: "error",
              reason: "ownership-changed",
              message: "DSH plugin ownership changed before managed residue cleanup",
            };
          }
          const lockedContract = dshContractForMarker(locked.marker);
          if (!lockedContract) {
            return {
              status: "error",
              reason: "version-unsupported",
              message: `The installed DeepSeek Harness marker targets ${locked.marker.installedDshVersion || "an unknown version"}; refusing to clean a managed residue for an unlisted contract`,
              detectedVersion: locked.marker.installedDshVersion || null,
              supportedRange: supportedDshRangeLabel(),
              manualInspectionRequired: true,
            };
          }
          if (lockedContract.version !== removalContract.version) {
            return {
              status: "error",
              reason: "ownership-changed",
              message: "DSH plugin contract changed before managed residue cleanup",
            };
          }
          const lockedLatch = await readInspectionLatch(options);
          return await cleanLockedManagedProfileResidue(locked, commandInfo, lockedLatch, options);
        } finally {
          await lock.release();
        }
      }
      return {
        status: "error",
        reason: "cli-unavailable",
        message: "DeepSeek Harness CLI is unavailable; the managed plugin was left installed",
        manualCommand: buildManualDshCommand([
          "npx",
          `@deepseek-ai/dsh@${removalContract.version}`,
          "plugin",
          "--profile",
          WEB_PROFILE_NAME,
          "remove",
          BRIDGE_PACKAGE_NAME,
        ], options),
      };
    }
    const dshVersion = await readDshVersion(commandInfo, options);
    if (!isSupportedDshVersion(dshVersion)) {
      return {
        status: "error",
        reason: "version-unsupported",
        message: `DeepSeek Harness ${dshVersion || "unknown"} is unsupported; refusing to mutate it with a removal contract for an unlisted version (supported: ${supportedDshRangeLabel()})`,
        detectedVersion: dshVersion,
        supportedRange: supportedDshRangeLabel(),
        manualInspectionRequired: true,
      };
    }
    const lock = await acquireMutationLock(options);
    try {
      const locked = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
      const lockedVersion = await readDshVersion(commandInfo, options);
      if (!isSupportedDshVersion(lockedVersion)) {
        return {
          status: "error",
          reason: "version-unsupported",
          message: `DeepSeek Harness ${lockedVersion || "unknown"} is unsupported; refusing to mutate it with a removal contract for an unlisted version (supported: ${supportedDshRangeLabel()})`,
          detectedVersion: lockedVersion,
          supportedRange: supportedDshRangeLabel(),
          manualInspectionRequired: true,
        };
      }
      if (
        !hasMutableManagedState(locked)
        || !locked.owned
        || !locked.marker
        || locked.marker.bundleHash !== before.marker.bundleHash
      ) {
        return { status: "error", reason: "ownership-changed", message: "DSH plugin ownership changed before removal" };
      }
      const lockedLatch = await readInspectionLatch(options);
      if (locked.status === "managed-residue") {
        return await cleanLockedManagedProfileResidue(locked, commandInfo, lockedLatch, options);
      }
      const pnpmRuntime = await resolvePnpmRuntime(commandInfo, options);
      if (!pnpmRuntime.available) {
        return { status: "error", reason: "pnpm-unavailable", message: "pnpm is required by dsh plugin remove" };
      }
      const result = await runDshCommand([
        "plugin", "--profile", WEB_PROFILE_NAME, "remove", BRIDGE_PACKAGE_NAME,
      ], { ...options, commandInfo: pnpmRuntime.commandInfo });
      if (result.code !== 0) {
        const failedHealth = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
        const unknown = isUnknownCommandResult(result);
        const changed = healthFingerprint(failedHealth) !== healthFingerprint(locked);
        if (unknown || changed) {
          await writeInspectionLatch(
            unknown ? "plugin-remove-unknown" : "plugin-remove-partial-mutation",
            (result.stderr || result.stdout || "dsh plugin remove failed").trim(),
            options
          );
          return {
            status: "error",
            reason: "inspection-required",
            message: (result.stderr || result.stdout || "dsh plugin remove had an unknown or partial result").trim(),
            manualInspectionRequired: true,
          };
        }
        return {
          status: "error",
          reason: "plugin-remove-failed",
          message: (result.stderr || result.stdout || "dsh plugin remove failed").trim(),
        };
      }
      let after = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
      if (after.status === "managed-residue") {
        const cleanup = await unlinkManagedProfileResidue(after, options);
        if (!cleanup.removed) {
          await writeInspectionLatch("plugin-remove-residue-cleanup-failed", cleanup.reason, options);
          return {
            status: "error",
            reason: "inspection-required",
            healthReason: after.status,
            cleanupReason: cleanup.reason,
            message: "dsh plugin remove left a profile-local package residue that could not be safely unlinked",
            manualInspectionRequired: true,
          };
        }
        after = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
      }
      if (after.status !== "absent" && after.status !== "profile-missing") {
        await writeInspectionLatch("plugin-remove-verification-failed", after.status, options);
        return {
          status: "error",
          reason: "inspection-required",
          healthReason: after.status,
          message: "dsh plugin remove completed but profile entries or a resolved package remain",
          manualInspectionRequired: true,
        };
      }
      await clearManualGenerationReference(options);
      await cleanUnreferencedGenerations(null, options);
      if (lockedLatch) await clearInspectionLatch(options);
      return { status: "ok", removed: true, updated: true };
    } finally {
      await lock.release();
    }
    });
  } catch (err) {
    if (err && err.code === "DSH_MANUAL_GENERATION_REFERENCE_INVALID") {
      return manualGenerationReferenceResult({ referencePath: err.referencePath }, options);
    }
    throw err;
  }
}

function installDeepSeekHarnessBridge(options = {}) {
  return syncDeepSeekHarnessIntegration({ ...options, operation: options.operation || "install" });
}

function registerDeepSeekHarness(options = {}) {
  return syncDeepSeekHarnessIntegration(options);
}

async function unregisterDeepSeekHarness(options = {}) {
  // Both registration routes are torn down here: a host that switched routes
  // must not be left with the other one still mounting the bridge. A failure on
  // the machine-level route degrades to a warning rather than stopping the
  // profile teardown — a damaged home patch must not make the bundle
  // un-uninstallable.
  const homePatchResult = await unregisterHomePatchBridge(options);
  const result = await uninstallDeepSeekHarnessBridge(options);
  const homePatchWarning = homePatchResult.status === "error"
    ? { reason: homePatchResult.reason, message: homePatchResult.message }
    : (homePatchResult.residualStableDir
      ? { reason: "stable-dir-not-owned", message: homePatchResult.warning }
      : null);
  if (result.status === "error") {
    return homePatchWarning ? { ...result, homePatchWarning } : result;
  }
  const homePatchRemoved = homePatchResult.status === "ok" && homePatchResult.action === "removed";
  const removed = homePatchRemoved || result.status === "ok";
  return {
    ...result,
    homePatchRemoved,
    ...(homePatchWarning ? { homePatchWarning } : {}),
    removed,
    skipped: !removed,
  };
}

async function isBridgeInstalled(options = {}) {
  return (await inspectDeepSeekHarnessIntegration(options)).status === "healthy";
}

// ---------------------------------------------------------------------------
// Machine-level registration: $DSH_HOME/cordis.patch.yml
//
// The Electron desktop app reserves its own `desktop` profile and refuses
// `dsh plugin --profile desktop`, so the profile route can never reach it. The
// home-level patch layer applies over every profile's own layer and accepts an
// absolute entry `name`, so Clawd materialises the bridge once under the DSH
// home and registers it there instead: one registration that reaches `web` and
// `desktop` alike, with no pnpm install into any profile.
//
// The two registration routes must never be active at the same time. A
// top-level `insert` appends without deduping, so a bundled entry plus a home
// entry would mount the bridge twice and double every state event.
// ---------------------------------------------------------------------------

const HOME_PATCH_REFERENCE_FILE = "home-patch-reference.json";

function resolveDesktopProfileDir(dshHome) {
  return path.join(dshHome, "profiles", DESKTOP_PROFILE_NAME);
}

async function isDesktopTargetPresent(options = {}) {
  if (typeof options.desktopTargetPresent === "boolean") return options.desktopTargetPresent;
  const dshHome = resolveCanonicalDshHome(options);
  return exists(path.join(resolveDesktopProfileDir(dshHome), "package.json"));
}

function homePatchReferencePath(options = {}) {
  return path.join(resolveManagedRoot(options), HOME_PATCH_REFERENCE_FILE);
}

/**
 * Inspect the machine-level registration without mutating anything.
 * @returns a health object; `status` is `ok`, `absent`, `foreign-target`,
 *   `block-malformed`, `marker-invalid`, or `unreadable`.
 */
async function inspectHomePatchRegistration(options = {}) {
  // Canonicalize on every path so the written block and the later inspection
  // agree: a DSH home reached through a symlink (macOS /var -> /private/var)
  // would otherwise compare as a foreign target.
  const dshHome = resolveCanonicalDshHome(options);
  const patchPath = homePatch.resolveHomePatchPath(dshHome);
  const stableDir = homePatch.resolveStableBridgeDir(dshHome);
  const stableEntry = homePatch.resolveStableBridgeEntry(dshHome);
  const reference = await readJson(homePatchReferencePath(options));
  const base = { patchPath, stableDir, stableEntry, reference };
  let content;
  try {
    content = await homePatch.readHomePatchFile(patchPath);
  } catch (err) {
    return { ...base, status: "unreadable", message: err && err.message ? err.message : String(err) };
  }
  const found = homePatch.findManagedBlock(content);
  if (found.malformed) return { ...base, status: "block-malformed" };
  if (!found.present) return { ...base, status: "absent" };
  if (!homePatch.sameEntryPath(found.targetPath, stableEntry)) {
    return { ...base, status: "foreign-target", targetPath: found.targetPath };
  }
  const marker = await readJson(path.join(stableDir, MANIFEST_FILE));
  const markerContract = marker ? dshContractForMarker(marker) : null;
  if (!marker || marker.owner !== MANAGED_OWNER || !markerContract) {
    return { ...base, status: "marker-invalid", marker };
  }
  const actualHash = await hashBridgeDirectory(stableDir, markerContract);
  if (actualHash !== marker.bundleHash) {
    return { ...base, status: "marker-invalid", marker, message: "managed bytes do not match their marker" };
  }
  return { ...base, status: "ok", marker };
}

/**
 * Write the bridge into its stable directory under the DSH home.
 * Idempotent: the bytes are skipped when the marker already matches.
 */
async function materializeStableBridge(bundle, options = {}) {
  const dshHome = resolveCanonicalDshHome(options);
  const stableDir = options.stableDir || homePatch.resolveStableBridgeDir(dshHome);
  const contract = options.contract || dshContractForVersion(options.dshVersion) || PREFERRED_DSH_CONTRACT;
  const manifest = {
    owner: MANAGED_OWNER,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    packageName: BRIDGE_PACKAGE_NAME,
    bundleHash: bundle.bundleHash,
    sourceClawdVersion: await sourceClawdVersion(options),
    supportedDshRange: contract.supportedDshRange,
    installedDshVersion: options.dshVersion || contract.version,
    installedDshVersionAssumedAtStaging: options.dshVersionAssumed === true,
    verifiedDshArtifact: contract.verifiedDshArtifact,
    verifiedDshArtifactIntegrity: contract.verifiedDshArtifactIntegrity,
    sourceAuditBaselineCommit: SOURCE_AUDIT_BASELINE_COMMIT,
    registration: "home-patch",
    installedAt: new Date().toISOString(),
  };
  const existing = await readJson(path.join(stableDir, MANIFEST_FILE));
  const existingContract = existing ? dshContractForMarker(existing) : null;
  if (
    existing
    && existing.owner === MANAGED_OWNER
    && existing.bundleHash === bundle.bundleHash
    && existingContract
    && existingContract.version === contract.version
    && (await hashBridgeDirectory(stableDir, existingContract)) === bundle.bundleHash
  ) {
    return { stableDir, created: false, manifest: existing };
  }
  const parentDir = path.dirname(stableDir);
  await fsp.mkdir(parentDir, { recursive: true });
  const stagingDir = `${stableDir}.staging-${process.pid}-${crypto.randomUUID()}`;
  await fsp.mkdir(stagingDir, { recursive: false });
  try {
    for (const file of bundle.files) {
      const target = path.join(stagingDir, ...file.relativePath.split("/"));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, file.content, { flag: "wx" });
    }
    await fsp.writeFile(
      path.join(stagingDir, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 }
    );
    const retiredDir = await exists(stableDir)
      ? `${stableDir}.retired-${Date.now()}`
      : null;
    if (retiredDir) await fsp.rename(stableDir, retiredDir);
    try {
      await fsp.rename(stagingDir, stableDir);
    } catch (err) {
      if (retiredDir) {
        try { await fsp.rename(retiredDir, stableDir); } catch {}
      }
      throw err;
    }
    if (retiredDir) {
      try { await fsp.rm(retiredDir, { recursive: true, force: true }); } catch {}
    }
    return { stableDir, created: true, manifest };
  } catch (err) {
    try { await fsp.rm(stagingDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

/**
 * Synchronous twin of {@link inspectHomePatchRegistration}, for the disk-only
 * detection paths that cannot await.
 */
function inspectHomePatchRegistrationSync(options = {}) {
  const fsImpl = options.fs || fs;
  const dshHome = resolveCanonicalDshHome(options);
  const patchPath = homePatch.resolveHomePatchPath(dshHome);
  const stableDir = homePatch.resolveStableBridgeDir(dshHome);
  const stableEntry = homePatch.resolveStableBridgeEntry(dshHome);
  const base = { patchPath, stableDir, stableEntry };
  let content = "";
  try {
    content = fsImpl.readFileSync(patchPath, "utf8");
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      return { ...base, status: "unreadable", message: err && err.message ? err.message : String(err) };
    }
  }
  const found = homePatch.findManagedBlock(content);
  if (found.malformed) return { ...base, status: "block-malformed" };
  if (!found.present) return { ...base, status: "absent" };
  if (!homePatch.sameEntryPath(found.targetPath, stableEntry, fsImpl)) {
    return { ...base, status: "foreign-target", targetPath: found.targetPath };
  }
  const marker = readJsonSync(fsImpl, path.join(stableDir, MANIFEST_FILE));
  const markerContract = marker ? dshContractForMarker(marker) : null;
  if (!marker || marker.owner !== MANAGED_OWNER || !markerContract) {
    return { ...base, status: "marker-invalid", marker };
  }
  if (hashBridgeDirectorySync(fsImpl, stableDir, markerContract) !== marker.bundleHash) {
    return { ...base, status: "marker-invalid", marker, message: "managed bytes do not match their marker" };
  }
  return { ...base, status: "ok", marker };
}

async function writeHomePatchReference(patchPlan, options = {}) {
  const filePath = homePatchReferencePath(options);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const payload = {
    owner: MANAGED_OWNER,
    schemaVersion: 1,
    packageName: BRIDGE_PACKAGE_NAME,
    registration: "home-patch",
    patchPath: patchPlan.patchPath,
    stableEntry: patchPlan.stableEntry,
    createdAt: new Date().toISOString(),
  };
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fsp.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await fsp.rename(tempPath, filePath);
  return payload;
}

async function clearHomePatchReference(options = {}) {
  const filePath = homePatchReferencePath(options);
  try {
    await fsp.rm(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Whether the stable directory is Clawd's own, by marker and by bytes. */
async function isOwnedStableDir(stableDir, options = {}) {
  const marker = await readJson(path.join(stableDir, MANIFEST_FILE));
  const markerContract = marker ? dshContractForMarker(marker) : null;
  if (!marker || marker.owner !== MANAGED_OWNER || !markerContract) return false;
  return (await hashBridgeDirectory(stableDir, markerContract)) === marker.bundleHash;
}

/**
 * The profile a composition check may safely compose: one that already exists
 * and that the CLI is allowed to touch. `desktop` is excluded because
 * `dsh --profile desktop` is refused outright, so composing it is impossible —
 * which is exactly why the check must fall back to something else rather than
 * silently testing nothing on a desktop-only machine.
 */
async function resolveComposableProfileNames(dshHome) {
  const profilesDir = path.join(dshHome, "profiles");
  let entries;
  try {
    entries = await fsp.readdir(profilesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === DESKTOP_PROFILE_NAME) continue;
    // A profile name the CLI would refuse must never become a candidate: its
    // dump would fail for a reason that says nothing about our own write.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) continue;
    const dir = path.join(profilesDir, entry.name);
    const initialized = (await exists(path.join(dir, "package.json")))
      && ((await exists(path.join(dir, PROFILE_ROOT_FILE)))
        || (await exists(path.join(dir, "cordis.patch.yml"))));
    if (initialized) names.push(entry.name);
  }
  return names.sort((left, right) => {
    if (left === WEB_PROFILE_NAME) return -1;
    if (right === WEB_PROFILE_NAME) return 1;
    return left.localeCompare(right);
  });
}

/**
 * Prove the entry Clawd registered is actually loadable.
 *
 * This is the host-independent half of the boot proof: composing the profile
 * tree can only be done where a CLI and a composable profile exist, but this
 * check runs everywhere — including the desktop-only host this route exists
 * for, where `--dump-config` is impossible. It covers the only failures Clawd
 * itself can introduce: a path that does not resolve to a file, and a module
 * that does not load or does not export `apply`.
 * @returns `{ ok }` or `{ ok: false, message }`.
 */
async function verifyHomePatchEntry(entryPath, options = {}) {
  if (typeof options.verifyEntryImpl === "function") {
    return await options.verifyEntryImpl(entryPath, options);
  }
  let stat;
  try {
    stat = await fsp.lstat(entryPath);
  } catch {
    return { ok: false, message: `the registered bridge entry does not exist: ${entryPath}` };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { ok: false, message: `the registered bridge entry is not a regular file: ${entryPath}` };
  }
  let loaded;
  try {
    // ESM caches by URL, and the stable directory keeps the same path across
    // content changes — so a re-verification in one process could be handed the
    // previously imported module. A content-addressed query keeps the check
    // tied to the bytes actually on disk.
    const cacheKey = typeof options.cacheKey === "string" && options.cacheKey
      ? `?clawd=${encodeURIComponent(options.cacheKey)}`
      : "";
    loaded = await import(`${pathToFileURL(entryPath).href}${cacheKey}`);
  } catch (err) {
    return {
      ok: false,
      message: `the registered bridge entry could not be imported: ${err && err.message ? err.message : String(err)}`,
    };
  }
  const apply = loaded.apply || loaded.default;
  if (typeof apply !== "function") {
    return { ok: false, message: `the registered bridge entry does not export apply(): ${entryPath}` };
  }
  return { ok: true };
}

/**
 * Undo the profile root file the compose rewrote — or created — and report it
 * when undoing fails: a silently lost user edit is the exact outcome the
 * snapshot exists to prevent, so a failed restore must not be swallowed.
 * @returns a warning string, or null when there was nothing to undo.
 */
async function restoreProfileRoot(rootPath, rootBefore, rootAfter, fspImpl = fsp) {
  if (rootBefore === rootAfter) return null;
  try {
    if (rootBefore === null) {
      // The compose created a file that was not there before; leaving it would
      // make the validation a mutation.
      await fspImpl.rm(rootPath, { force: true });
    } else {
      await fspImpl.writeFile(rootPath, rootBefore, { mode: 0o600 });
    }
    return null;
  } catch (err) {
    return `Composing the profile changed ${rootPath} and restoring it failed: ${err && err.message ? err.message : String(err)}`;
  }
}

async function readTextFileOrNull(filePath, fspImpl = fsp) {
  try {
    return await fspImpl.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Prove the composed tree still boots before Clawd keeps its write.
 *
 * A malformed home patch breaks the boot of every profile, so this is the last
 * line of defence after the structural checks. Two properties matter:
 *
 * - It composes whichever profile already exists, not just `web`, because the
 *   desktop-owned host this route exists for may have no web profile at all.
 * - `--dump-config` is not read-only: composing rewrites the profile root file.
 *   Whatever the user had there is captured first and restored after, so
 *   validating our own write never costs them their own bytes.
 * @returns `{ ok }`, or `{ ok: true, skipped, reason, warning }` when it could
 *   not run — a skip is reported, never silent.
 */
async function validateHomePatchComposition(options = {}) {
  if (typeof options.validateCompositionImpl === "function") {
    return await options.validateCompositionImpl(options);
  }
  const dshHome = resolveCanonicalDshHome(options);
  const candidates = await resolveComposableProfileNames(dshHome);
  if (candidates.length === 0) {
    return {
      ok: true,
      skipped: true,
      reason: "no-composable-profile",
      warning: "No DSH profile could be composed to verify the machine-level registration",
    };
  }
  const commandInfo = options.commandInfo || await resolveDshCommand(options);
  if (!commandInfo) {
    return {
      ok: true,
      skipped: true,
      reason: "cli-unavailable",
      warning: "No dsh CLI was available to verify the machine-level registration",
    };
  }
  // `web` is the profile the CLI is built around: a failure there is a real
  // verdict. Any other candidate is a fallback, so an inconclusive result from
  // one must not roll back a write the canonical profile would have accepted.
  let fallback = null;
  for (const profileName of candidates) {
    const attempt = await composeProfileOnce(profileName, { ...options, dshHome, commandInfo });
    if (attempt.ok) return { ok: true, profileName, ...attempt.restoreFields };
    // An inconclusive attempt never contradicts the write, whichever profile it
    // came from — the output cap losing the verdict is not a boot failure.
    if (attempt.inconclusive === true) {
      fallback = { profileName, ...attempt };
      continue;
    }
    if (profileName === WEB_PROFILE_NAME) return { ok: false, profileName, ...attempt };
    fallback = { profileName, ...attempt };
  }
  return {
    ok: true,
    skipped: true,
    reason: "composition-inconclusive",
    warning: fallback
      ? `No profile could be composed to verify the machine-level registration (${fallback.profileName}: ${fallback.message})`
      : "No profile could be composed to verify the machine-level registration",
  };
}

/**
 * One composition attempt against one profile, restoring the profile root file
 * it disturbs.
 * @returns `{ ok: true, restoreFields }` or `{ ok: false, message, restoreFields }`.
 */
async function composeProfileOnce(profileName, options) {
  const dshHome = resolveCanonicalDshHome(options);
  const fspImpl = options.fsp || fsp;
  const rootPath = path.join(dshHome, "profiles", profileName, PROFILE_ROOT_FILE);
  const rootBefore = await readTextFileOrNull(rootPath, fspImpl);
  const result = await runDshCommand(["--profile", profileName, "--dump-config"], {
    ...options,
    timeoutMs: 30000,
  });
  const rootAfter = await readTextFileOrNull(rootPath, fspImpl);
  const restoreWarning = await restoreProfileRoot(rootPath, rootBefore, rootAfter, fspImpl);
  const restoreFields = restoreWarning ? { rootRestoreFailed: true, warning: restoreWarning } : {};
  if (result.code === 0) return { ok: true, restoreFields };
  // The output cap kills the child, which loses the verdict rather than
  // contradicting it — that is a measurement failure, not a boot failure.
  if (result.outputLimited === true) {
    return {
      ok: false,
      inconclusive: true,
      message: "dsh --dump-config exceeded the output cap before it could report",
      ...restoreFields,
    };
  }
  return {
    ok: false,
    message: (result.stderr || result.stdout || "dsh --dump-config failed").trim().slice(0, 500),
    ...restoreFields,
  };
}

/** Put the patch file back the way it was before a write that did not validate. */
async function rollbackHomePatchWrite(patchPath, write, options = {}) {
  const fspImpl = options.fsp || fsp;
  try {
    if (write && write.backupPath) {
      const backup = await fspImpl.readFile(write.backupPath, "utf8");
      await fspImpl.writeFile(patchPath, backup, { mode: 0o600 });
      return true;
    }
    await fspImpl.rm(patchPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Move the bridge from the profile route to the machine-level route.
 *
 * Explicit by design: this is the only path that removes a registration the
 * user already had, so it never runs from a sync. If the profile teardown
 * fails it aborts without writing the home patch — both routes live at once
 * would mount the bridge twice and double every state event.
 */
async function migrateHomePatchRegistration(options = {}) {
  const dshHome = resolveCanonicalDshHome(options);
  const bundled = inspectDeepSeekHarnessDiskSync({ ...options, dshHome });
  const profileRouteLive = Boolean(
    bundled
    && (bundled.status === "healthy"
      || (bundled.dependencyPresent === true && bundled.bundlePresent === true))
  );
  if (!profileRouteLive) {
    return {
      status: "skipped",
      reason: "no-profile-route",
      message: "No profile registration needed migrating",
    };
  }
  // Each step takes the on-disk mutation lock itself, so this sequence must not
  // hold it. The window between the two is safe: a concurrent sync that sees no
  // profile bundle simply registers the same machine-level entry, and the
  // second registration is idempotent.
  const removal = await uninstallDeepSeekHarnessBridge(options);
  if (removal.status === "error") {
    return {
      status: "error",
      reason: "migration-blocked",
      message: `Refusing to add the machine-level registration while the profile registration could not be removed: ${removal.message || removal.reason}`,
      manualInspectionRequired: true,
    };
  }
  const registered = await registerHomePatchBridge({ ...options, dshHome });
  if (registered.status !== "ok") return { ...registered, migrated: false };
  return { ...registered, migrated: true, profileRouteRemoved: true };
}

/**
 * Register the bridge through the machine-level home patch.
 *
 * Order matters here: the inspect gate and the pure plan both run before
 * anything is written, so a host Clawd must not touch is never half-mutated,
 * and a patch that cannot be edited never costs the previous stable copy.
 * @returns `{ status, action, patchPath, stableDir, backupPath }` or an error
 *   result when the routes would collide or the host needs manual inspection.
 */
async function registerHomePatchBridge(options = {}) {
  const dshHome = resolveCanonicalDshHome(options);
  // A profile bundle and a home entry would both mount the bridge, so this
  // route refuses to start while the profile route is live. The disk health
  // vocabulary is "healthy" (not this module's "ok"), and a bundle row plus a
  // resolved dependency is what actually makes the plugin load — so both are
  // checked rather than a single status name.
  if (options.skipCollisionCheck !== true) {
    const bundled = inspectDeepSeekHarnessDiskSync({ ...options, dshHome });
    const profileRouteLive = Boolean(
      bundled
      && (bundled.status === "healthy"
        || (bundled.dependencyPresent === true && bundled.bundlePresent === true))
    );
    if (profileRouteLive) {
      return {
        status: "error",
        reason: "migration-required",
        // Deliberately not automatic. Removing a registration from the user's
        // own DSH profile is a destructive change to their host, so it waits
        // for an explicit action — Settings/Doctor, or
        // `dsh-install.js --migrate-registration` — instead of happening on a
        // startup sync.
        migrationRequired: true,
        suggestedAction: "migrate-registration",
        profileDir: bundled.profileDir,
        message: "The Clawd bridge is registered through the DSH profile route; it must be migrated to the machine-level registration before that route can take over",
      };
    }
  }
  const patchPath = homePatch.resolveHomePatchPath(dshHome);
  const stableEntry = homePatch.resolveStableBridgeEntry(dshHome);
  const stableDir = path.dirname(path.dirname(stableEntry));

  // Never rewrite a state that inspection calls foreign or unreadable. A stale
  // marker of our own is the one exception: that is a previous install whose
  // bytes changed, which this call exists to refresh. Claiming that exception
  // takes more than the marker's own `owner` field — that file lives inside the
  // directory being replaced, so on its own it would let a forged marker
  // authorise deleting whatever sits there. The reference Clawd wrote outside
  // the directory is what proves authorship.
  const health = await inspectHomePatchRegistration({ ...options, dshHome });
  const savedReference = health.reference;
  const referenceProvesAuthorship = Boolean(
    savedReference
    && savedReference.owner === MANAGED_OWNER
    && savedReference.registration === "home-patch"
    && homePatch.sameEntryPath(savedReference.stableEntry, stableEntry, options.fs || fs)
  );
  const refreshable = health.status === "marker-invalid"
    && health.marker
    && health.marker.owner === MANAGED_OWNER
    && referenceProvesAuthorship;
  if (health.status !== "absent" && health.status !== "ok" && !refreshable) {
    return {
      status: "error",
      reason: health.status,
      message: `The machine-level DSH registration needs manual inspection (${health.status})`,
      manualInspectionRequired: true,
      patchPath,
      stableDir,
      targetPath: health.targetPath,
    };
  }

  // Plan the pure part first: this is the only step that can refuse the write
  // on the user's own content, and it must cost nothing when it does.
  let content;
  try {
    content = await homePatch.readHomePatchFile(patchPath);
  } catch (err) {
    return { status: "error", reason: "patch-unreadable", message: err && err.message ? err.message : String(err) };
  }
  let plan;
  try {
    plan = homePatch.planManagedBlockWrite(content, stableEntry);
  } catch (err) {
    return { status: "error", reason: "patch-not-editable", message: err && err.message ? err.message : String(err) };
  }

  const bundle = await readSourceBundle(options);
  const contract = options.contract
    || dshContractForVersion(options.dshVersion)
    || PREFERRED_DSH_CONTRACT;
  const materialized = await materializeStableBridge(bundle, { ...options, contract, stableDir });
  const write = await homePatch.writeHomePatchFile(patchPath, plan);

  // Prove the entry loads everywhere, then — only where a CLI and a composable
  // profile exist — prove the composed tree still boots. A write that changed
  // nothing needs neither: an idempotent sync must not spawn a `dsh` process or
  // touch the profile root file on every start.
  const entryCheck = await verifyHomePatchEntry(stableEntry, { ...options, cacheKey: bundle.bundleHash });
  const validation = !entryCheck.ok
    ? { ok: false, reason: "entry-verification-failed", message: entryCheck.message }
    : (write.action === "unchanged"
      ? { ok: true, skipped: true, reason: "unchanged" }
      : await validateHomePatchComposition({ ...options, dshHome }));
  if (!validation.ok) {
    const rolledBack = await rollbackHomePatchWrite(patchPath, write, options);
    return {
      status: "error",
      reason: validation.reason || "patch-validation-failed",
      message: validation.reason === "entry-verification-failed"
        ? `The Clawd bridge entry Clawd registered is not loadable: ${validation.message}`
        : `The composed DSH profile tree no longer boots after registering the Clawd bridge: ${validation.message}`,
      manualInspectionRequired: true,
      patchPath,
      stableDir,
      rolledBack,
      ...(validation.warning ? { compositionValidationWarning: validation.warning } : {}),
    };
  }

  const reference = await writeHomePatchReference({ patchPath, stableEntry }, options);
  return {
    status: "ok",
    action: write.action,
    patchPath,
    stableDir: materialized.stableDir,
    stableEntry,
    backupPath: write.backupPath,
    created: materialized.created,
    reference,
    ...(validation.skipped ? { compositionValidationSkipped: validation.reason } : {}),
    ...(validation.warning ? { compositionValidationWarning: validation.warning } : {}),
    entryVerified: entryCheck.ok,
    message: DSH_RESTART_HINT,
  };
}

/**
 * Remove the machine-level registration. Only Clawd's own block is touched.
 * @returns `{ status, action }` where action is `removed`, `absent`, or `unchanged`.
 */
async function unregisterHomePatchBridge(options = {}) {
  // Canonicalize on every path so the written block and the later inspection
  // agree: a DSH home reached through a symlink (macOS /var -> /private/var)
  // would otherwise compare as a foreign target.
  const dshHome = resolveCanonicalDshHome(options);
  const patchPath = homePatch.resolveHomePatchPath(dshHome);
  const stableDir = homePatch.resolveStableBridgeDir(dshHome);
  let content;
  try {
    content = await homePatch.readHomePatchFile(patchPath);
  } catch (err) {
    return { status: "error", reason: "patch-unreadable", message: err && err.message ? err.message : String(err) };
  }
  let plan;
  try {
    plan = homePatch.planManagedBlockRemoval(content);
  } catch (err) {
    return { status: "error", reason: "patch-not-editable", message: err && err.message ? err.message : String(err) };
  }
  const write = await homePatch.writeHomePatchFile(patchPath, plan);
  await clearHomePatchReference(options);
  // Deleting recursively is only safe for a directory Clawd can prove is its
  // own. A foreign occupant at this path is left alone and reported instead —
  // the same rule the profile route applies to a foreign same-name package.
  let residualStableDir = false;
  if (options.keepStableDir !== true && (await exists(stableDir))) {
    if (await isOwnedStableDir(stableDir, options)) {
      await fsp.rm(stableDir, { recursive: true, force: true });
    } else {
      residualStableDir = true;
    }
  }
  return {
    status: "ok",
    action: write.action,
    patchPath,
    stableDir,
    backupPath: write.backupPath,
    ...(residualStableDir
      ? {
        residualStableDir: true,
        warning: `Kept ${stableDir}: it is not a Clawd-owned stable bridge copy`,
      }
      : {}),
  };
}

module.exports = {
  BRIDGE_PACKAGE_NAME,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SOURCE_FILES,
  DSH_RESTART_HINT,
  DSH_VERSION_CONTRACTS,
  MANAGED_OWNER,
  PREFERRED_DSH_CONTRACT,
  SUPPORTED_DSH_RANGE,
  SUPPORTED_DSH_VERSION,
  VERIFIED_DSH_ARTIFACT,
  VERIFIED_DSH_ARTIFACT_INTEGRITY,
  WEB_PROFILE_NAME,
  dshContractForMarker,
  dshContractForVersion,
  isSupportedDshVersion,
  supportedDshRangeLabel,
  dshCommandPathsSync,
  hasDshCommand,
  hasPnpm,
  inspectHomePatchRegistration,
  inspectHomePatchRegistrationSync,
  isDesktopTargetPresent,
  migrateHomePatchRegistration,
  registerHomePatchBridge,
  resolveDesktopProfileDir,
  unregisterHomePatchBridge,
  installDeepSeekHarnessBridge,
  inspectDeepSeekHarnessDiskSync,
  inspectDeepSeekHarnessIntegration,
  isBridgeInstalled,
  isDshInstalled,
  registerDeepSeekHarness,
  resolveBridgeSourceDir,
  resolveDshCommand,
  resolveDshHome,
  resolveDshInstallRootSync,
  resolveDshProfileDir,
  resolveManagedRoot,
  runDshCommand,
  syncDeepSeekHarnessIntegration,
  unregisterDeepSeekHarness,
  uninstallDeepSeekHarnessBridge,
  __test: {
    acquireMutationLock,
    cleanUnreferencedGenerations,
    compareVersions,
    discardCreatedGenerationIfUnreferenced,
    hashBridgeDirectorySync,
    healthFingerprint,
    inspectionLatchPath,
    isGenerationReferenced,
    unlinkManagedProfileResidue,
    manualGenerationReferencePath,
    readManualGenerationReference,
    buildManualDshCommand,
    computeExpectedSourceHashesSync,
    digestBridgeFiles,
    dshContractForMarker,
    dshContractForVersion,
    isSupportedDshVersion,
    resolveCanonicalDshHome,
    packagePath,
    parseDshVersion,
    promoteGeneration,
    readSourceBundle,
    runCommand,
    supportedDshRangeLabel,
    verifyHomePatchEntry,
  },
};

if (require.main === module) {
  const uninstall = process.argv.includes("--uninstall") || process.argv.includes("--uninstall-bridge");
  const migrate = process.argv.includes("--migrate-registration");
  const operation = process.argv.includes("--repair") ? "explicit-repair" : "install";
  Promise.resolve(migrate
    ? migrateHomePatchRegistration({ silent: false })
    : uninstall
      ? unregisterDeepSeekHarness({ silent: false })
      : syncDeepSeekHarnessIntegration({ silent: false, operation }))
    .then((result) => {
      if (result && result.status === "error") {
        console.error(result.message || result.reason || "DeepSeek Harness integration failed");
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error(err && err.message ? err.message : err);
      process.exitCode = 1;
    });
}
