#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const MANIFEST_VERSION = 1;
const ENC_MAGIC = Buffer.from("OPCENC1\0", "ascii");
const SALT_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "ascii");

const AGENT_HUB_ALLOWLIST = new Set([
  "hub.db",
  "plans.json",
  "pricing.json",
  "models.json",
  "topics.json",
  "local_topics.json",
  "tasks.md",
  "pomodoro.json",
  "inspiration-inbox-processed.json",
  "generated_paths.json",
]);

const OPC_OS_ROOT_ALLOWLIST = new Set(["chatroom.db", "credentials.json"]);

function firstExistingDir(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const abs = resolve(candidate);
    try {
      if (statSync(abs).isDirectory()) return abs;
    } catch {
      // skip missing
    }
  }
  return null;
}

function formatTimestamp(date = new Date()) {
  const pad = n => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function isSqliteFile(filePath) {
  if (!/\.(db|sqlite|sqlite3)$/i.test(filePath)) return false;
  let fd;
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size < SQLITE_MAGIC.length) return false;
    fd = openSync(filePath, "r");
    const header = Buffer.alloc(SQLITE_MAGIC.length);
    const bytesRead = readSync(fd, header, 0, SQLITE_MAGIC.length, 0);
    return bytesRead === SQLITE_MAGIC.length && header.equals(SQLITE_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function checkSqliteIntegrity(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA integrity_check;").all();
    const messages = rows.map(r => String(Object.values(r)[0] ?? ""));
    const ok = messages.length === 1 && messages[0].toLowerCase() === "ok";
    return { ok, detail: messages.join("; ") || "unknown" };
  } finally {
    db.close();
  }
}

function hotBackupSqlite(srcPath, destPath) {
  mkdirSync(dirname(destPath), { recursive: true });
  rmSync(destPath, { force: true });
  const db = new DatabaseSync(srcPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const escaped = destPath.replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escaped}';`);
  } finally {
    db.close();
  }
  const integrity = checkSqliteIntegrity(destPath);
  if (!integrity.ok) {
    throw new Error(`SQLite 热备完整性校验失败 (${basename(srcPath)}): ${integrity.detail}`);
  }
  return integrity;
}

function assertSafeRelPath(relPath, context = "path") {
  if (typeof relPath !== "string" || !relPath || relPath.includes("\0")) {
    throw new Error(`非法的相对路径 (${context}): ${String(relPath)}`);
  }
  const normalized = relPath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`禁止使用绝对路径 (${context}): ${relPath}`);
  }
  const parts = normalized.split("/");
  if (parts.some(p => p === "" || p === "." || p === "..")) {
    throw new Error(`检测到路径穿越或非法片段 (${context}): ${relPath}`);
  }
  return parts.join("/");
}

function assertWithinDir(baseDir, candidatePath) {
  const absBase = resolve(baseDir);
  const absCandidate = resolve(candidatePath);
  const rel = relative(absBase, absCandidate);
  if (!rel || rel === "." || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return absCandidate;
  }
  throw new Error(`目标路径越界：${candidatePath} 超出允许目录 ${baseDir}`);
}

export function encryptBuffer(plainBuffer, passphrase) {
  if (!passphrase || typeof passphrase !== "string") {
    throw new Error("启用 --encrypt 时必须提供非空口令（通过 OPC_BACKUP_PASSPHRASE 或 --passphrase-file）");
  }
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const aad = Buffer.concat([ENC_MAGIC, salt, iv]);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENC_MAGIC, salt, iv, tag, encrypted]);
}

export function decryptBuffer(encBuffer, passphrase) {
  const minLen = ENC_MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;
  if (!Buffer.isBuffer(encBuffer) || encBuffer.length < minLen) {
    throw new Error("加密备份文件格式损坏或长度不足");
  }
  const magic = encBuffer.subarray(0, ENC_MAGIC.length);
  if (!magic.equals(ENC_MAGIC)) {
    throw new Error("无法识别的加密备份文件头（期望 OPCENC1）");
  }
  if (!passphrase || typeof passphrase !== "string") {
    throw new Error("该备份已加密，请通过环境变量 OPC_BACKUP_PASSPHRASE 或 --passphrase-file 提供口令");
  }
  const saltStart = ENC_MAGIC.length;
  const ivStart = saltStart + SALT_LEN;
  const tagStart = ivStart + IV_LEN;
  const bodyStart = tagStart + TAG_LEN;
  const salt = encBuffer.subarray(saltStart, ivStart);
  const iv = encBuffer.subarray(ivStart, tagStart);
  const tag = encBuffer.subarray(tagStart, bodyStart);
  const ciphertext = encBuffer.subarray(bodyStart);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const aad = Buffer.concat([ENC_MAGIC, salt, iv]);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("解密失败：口令错误或备份文件已被篡改");
  }
}

function isEncryptedArchive(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const header = Buffer.alloc(ENC_MAGIC.length);
    const bytesRead = readSync(fd, header, 0, ENC_MAGIC.length, 0);
    return bytesRead === ENC_MAGIC.length && header.equals(ENC_MAGIC);
  } catch {
    return filePath.endsWith(".enc");
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export function resolvePassphrase({ passphrase, passphraseFile, env = process.env } = {}) {
  if (typeof passphrase === "string" && passphrase.length > 0) return passphrase;
  if (passphraseFile) {
    return readFileSync(resolve(passphraseFile), "utf8").replace(/\r?\n$/, "");
  }
  if (typeof env.OPC_BACKUP_PASSPHRASE === "string" && env.OPC_BACKUP_PASSPHRASE.length > 0) {
    return env.OPC_BACKUP_PASSPHRASE;
  }
  return "";
}

function defaultSkipFile(name) {
  if (
    name === ".DS_Store" ||
    name === "Thumbs.db" ||
    name.endsWith(".tmp") ||
    name.endsWith(".bak") ||
    name.endsWith(".lock") ||
    name.includes(".lock.db") ||
    name.startsWith("before-") ||
    name.startsWith("test_")
  ) {
    return true;
  }
  // Skip SQLite sidecars (VACUUM INTO captures WAL transactions cleanly)
  if (/\.(db|sqlite|sqlite3)-(wal|shm|journal)$/i.test(name)) {
    return true;
  }
  return false;
}

function skipCompanionRuntimeFile(name) {
  if (defaultSkipFile(name)) return true;
  const lower = name.toLowerCase();
  if (
    lower === "pids.json" ||
    lower === "pid.json" ||
    lower.endsWith(".pid") ||
    lower.endsWith("-pid.json") ||
    lower.endsWith("_pid.json") ||
    lower.endsWith(".log")
  ) {
    return true;
  }
  return false;
}

function collectFiles(dirPath, { recursive = true, allowlist = null, skipFile = defaultSkipFile } = {}) {
  const results = [];
  if (!dirPath || !existsSync(dirPath)) return results;

  function walk(currentDir, prefix) {
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const name = entry.name;
      if (name === ".git" || name === "node_modules" || name === "__pycache__" || name === "backups") {
        continue;
      }
      const abs = join(currentDir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (recursive && !allowlist) {
          walk(abs, rel);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (allowlist && !allowlist.has(name)) continue;
      if (skipFile && skipFile(name, rel)) continue;
      results.push({ abs, rel });
    }
  }

  walk(dirPath, "");
  return results;
}

export function discoverSlots({
  rootDir = REPO_ROOT,
  homeDir = homedir(),
  env = process.env,
  full = false,
  includeHub = false,
  includeAgentHome = false,
} = {}) {
  const root = resolve(rootDir);
  const slots = [];

  const localDir = firstExistingDir([env.KUNLUN_LOCAL_DIR, join(root, "data", "zoom-local")]);
  if (localDir) {
    slots.push({
      id: "opc-os-local",
      label: "OPC OS 本地主库与运行凭据",
      scope: "workspace",
      targetRel: "opc-os/data/zoom-local",
      sourceDir: localDir,
      collect: () =>
        collectFiles(localDir, {
          recursive: false,
          skipFile: name => defaultSkipFile(name) || name.startsWith("."),
        }),
    });
  }

  const rootDataDir = firstExistingDir([join(root, "data")]);
  if (rootDataDir) {
    slots.push({
      id: "opc-os-root",
      label: "OPC OS 根目录主库与配置",
      scope: "workspace",
      targetRel: "opc-os/data",
      sourceDir: rootDataDir,
      collect: () =>
        collectFiles(rootDataDir, {
          recursive: false,
          allowlist: OPC_OS_ROOT_ALLOWLIST,
          skipFile: defaultSkipFile,
        }),
    });
  }

  const companionRuntimeBase = env.OPC_COMPANION_RUNTIME_DIR
    ? resolve(env.OPC_COMPANION_RUNTIME_DIR)
    : join(root, "data", "companion-runtime");
  const companionServices = [
    { service: "commerce", id: "opc-companion-commerce", label: "OPC 托管商业伴生运行库（含 License Ed25519 密钥）" },
    { service: "gtm", id: "opc-companion-gtm", label: "OPC 托管 GTM 伴生运行库" },
    { service: "ops", id: "opc-companion-ops", label: "OPC 托管客服与遥测伴生运行库" },
  ];
  for (const spec of companionServices) {
    const svcDir = firstExistingDir([join(companionRuntimeBase, spec.service)]);
    if (svcDir) {
      slots.push({
        id: spec.id,
        label: spec.label,
        scope: "workspace",
        targetRel: `opc-os/data/companion-runtime/${spec.service}`,
        sourceDir: svcDir,
        collect: () =>
          collectFiles(svcDir, {
            recursive: true,
            skipFile: skipCompanionRuntimeFile,
          }),
      });
    }
  }

  const commerceDir = firstExistingDir([
    env.OPC_COMMERCE_DIR ? join(env.OPC_COMMERCE_DIR, "data") : null,
    resolve(root, "../opc-commerce-kit/data"),
  ]);
  if (commerceDir) {
    slots.push({
      id: "opc-commerce",
      label: "商业套件主库（含订单与离线 License Ed25519 私钥）",
      scope: "workspace",
      targetRel: "opc-commerce-kit/data",
      sourceDir: commerceDir,
      collect: () => collectFiles(commerceDir, { recursive: true }),
    });
  }

  const gtmDir = firstExistingDir([
    env.OPC_GTM_DIR ? join(env.OPC_GTM_DIR, "data") : null,
    resolve(root, "../opc-gtm-kit/data"),
  ]);
  if (gtmDir) {
    slots.push({
      id: "opc-gtm",
      label: "GTM 获客与候补主库",
      scope: "workspace",
      targetRel: "opc-gtm-kit/data",
      sourceDir: gtmDir,
      collect: () => collectFiles(gtmDir, { recursive: true }),
    });
  }

  const opsDir = firstExistingDir([
    env.OPC_OPS_DIR ? join(env.OPC_OPS_DIR, "data") : null,
    resolve(root, "../opc-ops-kit/data"),
  ]);
  if (opsDir) {
    slots.push({
      id: "opc-ops",
      label: "客服工单与激活遥测主库",
      scope: "workspace",
      targetRel: "opc-ops-kit/data",
      sourceDir: opsDir,
      collect: () => collectFiles(opsDir, { recursive: true }),
    });
  }

  const analyticsDir = firstExistingDir([
    env.OPC_DATA_ANALYSIS_DIR ? join(env.OPC_DATA_ANALYSIS_DIR, "data") : null,
    resolve(root, "../data_analysis/data"),
    resolve(root, "../data-agent/data"),
    resolve(root, "../../self-test-grounding/data-agent/data"),
  ]);
  if (analyticsDir) {
    slots.push({
      id: "opc-analytics",
      label: "经营漏斗与 DuckDB 分析主库",
      scope: "workspace",
      targetRel: "data_analysis/data",
      sourceDir: analyticsDir,
      collect: () => collectFiles(analyticsDir, { recursive: true }),
    });
  }

  if (full || includeHub) {
    const hubDir = firstExistingDir([env.AGENT_HUB_DIR, join(homeDir, ".agent-hub")]);
    if (hubDir) {
      slots.push({
        id: "agent-hub",
        label: "Agent Hub 遥测与配额主库",
        scope: "home",
        targetRel: ".agent-hub",
        sourceDir: hubDir,
        collect: () =>
          collectFiles(hubDir, {
            recursive: false,
            allowlist: AGENT_HUB_ALLOWLIST,
            skipFile: defaultSkipFile,
          }),
      });
    }
  }

  if (full || includeAgentHome) {
    const agentHomeStateDir = firstExistingDir([
      env.OPC_AGENT_HOME_STATE_DIR,
      resolve(root, "../agent-home/.agent-state"),
      resolve(root, "../ppeng-agent-core/.agent-state"),
      resolve(root, "../../self-test-grounding/ppeng-agent-core/.agent-state"),
    ]);
    if (agentHomeStateDir) {
      slots.push({
        id: "agent-home",
        label: "Agent Home 运行态与 Bot 配置主库",
        scope: "workspace",
        targetRel: "agent-home/.agent-state",
        sourceDir: agentHomeStateDir,
        collect: () =>
          collectFiles(agentHomeStateDir, {
            recursive: false,
            skipFile: name =>
              defaultSkipFile(name) ||
              (name !== "runtime.sqlite" && !name.endsWith(".json") && !name.endsWith(".env")),
          }),
      });
    }
  }

  return slots;
}

function validateTarEntries(tarPath) {
  const verboseOut = execFileSync("tar", ["-tvzf", tarPath], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  for (const rawLine of verboseOut.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const typeChar = trimmed[0];
    if (typeChar === "l") {
      throw new Error(`备份归档包含禁止的符号链接条目：${trimmed}`);
    }
    if (typeChar === "h") {
      throw new Error(`备份归档包含禁止的硬链接条目：${trimmed}`);
    }
    if (typeChar !== "-" && typeChar !== "d") {
      throw new Error(`备份归档包含非法特殊文件条目：${trimmed}`);
    }
  }

  const out = execFileSync("tar", ["-tzf", tarPath], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const lines = out
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  for (const raw of lines) {
    const cleaned = raw.replace(/^\.\//, "").replace(/\/$/, "");
    if (!cleaned || cleaned === ".") continue;
    assertSafeRelPath(cleaned, "tar entry");
  }
  return lines;
}

function assertSafeExtractedTree(extractDir) {
  const rootLst = lstatSync(extractDir);
  if (!rootLst.isDirectory() || rootLst.isSymbolicLink()) {
    throw new Error("解压目录状态异常（非普通目录或为符号链接）");
  }
  const realRoot = realpathSync(extractDir);

  function walkVerify(currentDir, relPrefix) {
    const names = readdirSync(currentDir);
    for (const name of names) {
      const entryPath = join(currentDir, name);
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      const lst = lstatSync(entryPath);
      if (lst.isSymbolicLink()) {
        throw new Error(`检测到解压目录内存在非法符号链接：${rel}`);
      }
      if (lst.isDirectory()) {
        assertWithinDir(realRoot, realpathSync(entryPath));
        walkVerify(entryPath, rel);
      } else if (lst.isFile()) {
        if (lst.nlink > 1) {
          throw new Error(`检测到解压目录内存在非法硬链接：${rel}`);
        }
        assertWithinDir(realRoot, realpathSync(entryPath));
      } else {
        throw new Error(`检测到解压目录内存在非法特殊文件：${rel}`);
      }
    }
  }

  walkVerify(extractDir, "");
  return realRoot;
}

function movePrivateFileAtomic(stagedFilePath, finalOutPath) {
  mkdirSync(dirname(finalOutPath), { recursive: true, mode: 0o700 });
  chmodSync(stagedFilePath, 0o600);
  try {
    renameSync(stagedFilePath, finalOutPath);
    chmodSync(finalOutPath, 0o600);
    return;
  } catch (err) {
    if (!err || typeof err !== "object" || err.code !== "EXDEV") {
      throw err;
    }
  }

  // Cross-filesystem fallback: open a 0o600 temp file exclusively in target directory, write, then atomic rename
  const tmpTarget = join(dirname(finalOutPath), `.opc-backup-tmp-${randomBytes(8).toString("hex")}`);
  let fd;
  try {
    fd = openSync(tmpTarget, "wx", 0o600);
    const buf = readFileSync(stagedFilePath);
    writeSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    fd = undefined;
    chmodSync(tmpTarget, 0o600);
    renameSync(tmpTarget, finalOutPath);
    chmodSync(finalOutPath, 0o600);
    rmSync(stagedFilePath, { force: true });
  } catch (copyErr) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    rmSync(tmpTarget, { force: true });
    throw copyErr;
  }
}

export function createBackup({
  rootDir = REPO_ROOT,
  homeDir = homedir(),
  env = process.env,
  outPath = "",
  backupDir = "",
  encrypt = false,
  passphrase = "",
  passphraseFile = "",
  full = false,
  includeHub = false,
  includeAgentHome = false,
  verify = true,
} = {}) {
  const root = resolve(rootDir);
  const resolvedPassphrase = resolvePassphrase({ passphrase, passphraseFile, env });
  if (encrypt && !resolvedPassphrase) {
    throw new Error("启用 --encrypt 时必须提供口令（设置 OPC_BACKUP_PASSPHRASE 或传入 --passphrase-file）");
  }

  const slots = discoverSlots({ rootDir: root, homeDir, env, full, includeHub, includeAgentHome });
  const stagingRoot = mkdtempSync(join(tmpdir(), "opc-backup-stage-"));
  chmodSync(stagingRoot, 0o700);
  const ts = formatTimestamp();
  const targetDir = backupDir ? resolve(backupDir) : join(root, "data", "backups");
  let finalOut = outPath
    ? resolve(outPath)
    : join(targetDir, `opc-backup-${ts}.tar.gz${encrypt ? ".enc" : ""}`);
  if (encrypt && !finalOut.endsWith(".enc")) {
    finalOut = `${finalOut}.enc`;
  }

  try {
    const manifestSlots = [];
    const manifestFiles = [];
    let sqliteCount = 0;

    for (const slot of slots) {
      const entries = slot.collect();
      if (entries.length === 0) continue;

      let slotBytes = 0;
      for (const { abs, rel } of entries) {
        const safeRel = assertSafeRelPath(rel, `slot ${slot.id}`);
        const stagedPath = join(stagingRoot, "slots", slot.id, ...safeRel.split("/"));
        mkdirSync(dirname(stagedPath), { recursive: true });

        const st = statSync(abs);
        const mode = st.mode & 0o777;
        let kind = "file";
        let integrity = null;

        if (isSqliteFile(abs)) {
          hotBackupSqlite(abs, stagedPath);
          kind = "sqlite";
          integrity = "ok";
          sqliteCount += 1;
        } else {
          copyFileSync(abs, stagedPath);
        }

        const stagedStat = statSync(stagedPath);
        const sha256 = sha256File(stagedPath);
        slotBytes += stagedStat.size;
        manifestFiles.push({
          slotId: slot.id,
          relativePath: safeRel,
          kind,
          size: stagedStat.size,
          mode,
          sha256,
          ...(integrity ? { integrity } : {}),
        });
      }

      manifestSlots.push({
        id: slot.id,
        label: slot.label,
        scope: slot.scope,
        targetRel: slot.targetRel,
        fileCount: entries.length,
        sizeBytes: slotBytes,
      });
    }

    if (manifestFiles.length === 0) {
      throw new Error("未发现任何可备份的 OPC 主权数据文件，请确认当前处于正确的项目根目录");
    }

    const manifest = {
      schemaVersion: MANIFEST_VERSION,
      tool: "opc-backup",
      createdAt: new Date().toISOString(),
      full: Boolean(full),
      includeHub: Boolean(full || includeHub),
      includeAgentHome: Boolean(full || includeAgentHome),
      fileCount: manifestFiles.length,
      sqliteCount,
      totalSourceBytes: manifestFiles.reduce((acc, f) => acc + f.size, 0),
      slots: manifestSlots,
      files: manifestFiles,
    };

    writeFileSync(join(stagingRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const rawTarPath = join(stagingRoot, "bundle.tar.gz");
    execFileSync("tar", ["-czf", rawTarPath, "-C", stagingRoot, "manifest.json", "slots"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    chmodSync(rawTarPath, 0o600);

    if (encrypt) {
      const encryptedBuf = encryptBuffer(readFileSync(rawTarPath), resolvedPassphrase);
      const stagedEncPath = join(stagingRoot, "bundle.tar.gz.enc");
      writeFileSync(stagedEncPath, encryptedBuf, { mode: 0o600 });
      chmodSync(stagedEncPath, 0o600);
      rmSync(rawTarPath, { force: true });
      movePrivateFileAtomic(stagedEncPath, finalOut);
    } else {
      movePrivateFileAtomic(rawTarPath, finalOut);
    }

    const archiveSize = statSync(finalOut).size;
    let verification = null;
    if (verify) {
      verification = verifyBackup({
        archivePath: finalOut,
        passphrase: resolvedPassphrase,
      });
      if (!verification.ok) {
        throw new Error(`备份后自动校验失败：${verification.errors.join("；")}`);
      }
    }

    return {
      ok: true,
      archivePath: finalOut,
      encrypted: Boolean(encrypt),
      archiveSizeBytes: archiveSize,
      fileCount: manifest.fileCount,
      sqliteCount: manifest.sqliteCount,
      slots: manifest.slots,
      verified: Boolean(verification?.ok),
      manifest,
    };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function extractArchiveToTemp(archivePath, passphrase) {
  const absArchive = resolve(archivePath);
  if (!existsSync(absArchive)) {
    throw new Error(`备份文件不存在：${absArchive}`);
  }
  const workDir = mkdtempSync(join(tmpdir(), "opc-backup-verify-"));
  chmodSync(workDir, 0o700);
  const encrypted = isEncryptedArchive(absArchive);
  try {
    let tarPath = absArchive;
    if (encrypted) {
      const plain = decryptBuffer(readFileSync(absArchive), passphrase);
      tarPath = join(workDir, "decrypted.tar.gz");
      writeFileSync(tarPath, plain, { mode: 0o600 });
      chmodSync(tarPath, 0o600);
    }
    validateTarEntries(tarPath);
    const extractDir = join(workDir, "extracted");
    mkdirSync(extractDir, { recursive: true, mode: 0o700 });
    chmodSync(extractDir, 0o700);
    execFileSync("tar", ["-xzf", tarPath, "-C", extractDir]);
    assertSafeExtractedTree(extractDir);
    return { workDir, extractDir, encrypted };
  } catch (err) {
    rmSync(workDir, { recursive: true, force: true });
    throw err;
  }
}

function assertVerifiedExtractedFile(slotsRoot, realSlotsRoot, slotId, safeRel) {
  const parts = [slotId, ...safeRel.split("/")];
  let cur = slotsRoot;
  for (let i = 0; i < parts.length; i += 1) {
    cur = assertWithinDir(slotsRoot, join(cur, parts[i]));
    if (!existsSync(cur)) {
      return { exists: false, filePath: cur, lst: null };
    }
    const lst = lstatSync(cur);
    if (lst.isSymbolicLink()) {
      throw new Error(`非法符号链接路径：${slotId}/${safeRel}`);
    }
    const isLeaf = i === parts.length - 1;
    if (!isLeaf && !lst.isDirectory()) {
      throw new Error(`非法中间目录节点：${slotId}/${safeRel}`);
    }
    if (isLeaf) {
      if (!lst.isFile() || lst.nlink > 1) {
        throw new Error(`非法文件类型（非独立普通文件或硬链接）：${slotId}/${safeRel}`);
      }
      assertWithinDir(realSlotsRoot, realpathSync(cur));
      return { exists: true, filePath: cur, lst };
    }
    assertWithinDir(realSlotsRoot, realpathSync(cur));
  }
  return { exists: false, filePath: cur, lst: null };
}

function verifyExtractedArchive(extractDir, encrypted) {
  const realExtractDir = assertSafeExtractedTree(extractDir);
  const manifestPath = join(extractDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      encrypted,
      manifest: null,
      checkedFiles: 0,
      checkedSqlite: 0,
      errors: ["备份包缺少 manifest.json"],
    };
  }
  const manifestLst = lstatSync(manifestPath);
  if (!manifestLst.isFile() || manifestLst.isSymbolicLink() || manifestLst.nlink > 1) {
    return {
      ok: false,
      encrypted,
      manifest: null,
      checkedFiles: 0,
      checkedSqlite: 0,
      errors: ["manifest.json 文件类型非法（符号链接或硬链接）"],
    };
  }
  assertWithinDir(realExtractDir, realpathSync(manifestPath));

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest || manifest.schemaVersion !== MANIFEST_VERSION || !Array.isArray(manifest.files)) {
    return {
      ok: false,
      encrypted,
      manifest,
      checkedFiles: 0,
      checkedSqlite: 0,
      errors: ["manifest.json 版本不受支持或结构无效"],
    };
  }

  const errors = [];
  let checkedFiles = 0;
  let checkedSqlite = 0;
  const slotsRoot = join(extractDir, "slots");
  if (!existsSync(slotsRoot) || !lstatSync(slotsRoot).isDirectory() || lstatSync(slotsRoot).isSymbolicLink()) {
    return {
      ok: false,
      encrypted,
      manifest,
      checkedFiles: 0,
      checkedSqlite: 0,
      errors: ["备份包缺少合法的 slots 目录"],
    };
  }
  const realSlotsRoot = assertWithinDir(realExtractDir, realpathSync(slotsRoot));

  for (const item of manifest.files) {
    if (!/^[a-z0-9-]+$/.test(String(item.slotId ?? ""))) {
      errors.push(`非法槽位 ID：${String(item.slotId)}`);
      continue;
    }
    let safeRel;
    try {
      safeRel = assertSafeRelPath(item.relativePath, `manifest ${item.slotId}`);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      continue;
    }

    let resolvedFile;
    try {
      resolvedFile = assertVerifiedExtractedFile(slotsRoot, realSlotsRoot, item.slotId, safeRel);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      continue;
    }
    if (!resolvedFile.exists || !resolvedFile.lst) {
      errors.push(`缺失文件：${item.slotId}/${safeRel}`);
      continue;
    }
    const { filePath, lst } = resolvedFile;
    if (lst.size !== item.size) {
      errors.push(`文件大小不匹配：${item.slotId}/${safeRel}（期望 ${item.size}，实际 ${lst.size}）`);
      continue;
    }
    const actualSha = sha256File(filePath);
    if (actualSha !== item.sha256) {
      errors.push(`SHA-256 校验失败：${item.slotId}/${safeRel}`);
      continue;
    }
    checkedFiles += 1;

    if (item.kind === "sqlite") {
      try {
        const check = checkSqliteIntegrity(filePath);
        if (!check.ok) {
          errors.push(`SQLite 完整性校验失败：${item.slotId}/${safeRel}（${check.detail}）`);
        } else {
          checkedSqlite += 1;
        }
      } catch (e) {
        errors.push(
          `SQLite 无法打开：${item.slotId}/${safeRel}（${e instanceof Error ? e.message : String(e)}）`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    encrypted,
    manifest,
    checkedFiles,
    checkedSqlite,
    errors,
  };
}

export function verifyBackup({
  archivePath,
  passphrase = "",
  passphraseFile = "",
  env = process.env,
} = {}) {
  const resolvedPassphrase = resolvePassphrase({ passphrase, passphraseFile, env });
  const { workDir, extractDir, encrypted } = extractArchiveToTemp(archivePath, resolvedPassphrase);
  try {
    return verifyExtractedArchive(extractDir, encrypted);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function resolveRestoreSlotDir(slotMeta, { rootDir, homeDir, env, targetRoot }) {
  if (targetRoot) {
    const safeTargetRel = assertSafeRelPath(slotMeta.targetRel, `slot ${slotMeta.id} targetRel`);
    return assertWithinDir(targetRoot, join(resolve(targetRoot), ...safeTargetRel.split("/")));
  }

  const root = resolve(rootDir);
  const companionRuntimeBase = env.OPC_COMPANION_RUNTIME_DIR
    ? resolve(env.OPC_COMPANION_RUNTIME_DIR)
    : join(root, "data", "companion-runtime");
  switch (slotMeta.id) {
    case "opc-os-local":
      return resolve(env.KUNLUN_LOCAL_DIR || join(root, "data", "zoom-local"));
    case "opc-os-root":
      return join(root, "data");
    case "opc-companion-commerce":
      return join(companionRuntimeBase, "commerce");
    case "opc-companion-gtm":
      return join(companionRuntimeBase, "gtm");
    case "opc-companion-ops":
      return join(companionRuntimeBase, "ops");
    case "opc-companion-runtime":
      return companionRuntimeBase;
    case "opc-commerce":
      return env.OPC_COMMERCE_DIR
        ? join(resolve(env.OPC_COMMERCE_DIR), "data")
        : resolve(root, "../opc-commerce-kit/data");
    case "opc-gtm":
      return env.OPC_GTM_DIR ? join(resolve(env.OPC_GTM_DIR), "data") : resolve(root, "../opc-gtm-kit/data");
    case "opc-ops":
      return env.OPC_OPS_DIR ? join(resolve(env.OPC_OPS_DIR), "data") : resolve(root, "../opc-ops-kit/data");
    case "opc-analytics":
      return (
        firstExistingDir([
          env.OPC_DATA_ANALYSIS_DIR ? join(env.OPC_DATA_ANALYSIS_DIR, "data") : null,
          resolve(root, "../data_analysis/data"),
          resolve(root, "../data-agent/data"),
          resolve(root, "../../self-test-grounding/data-agent/data"),
        ]) || resolve(root, "../data_analysis/data")
      );
    case "agent-hub":
      return resolve(env.AGENT_HUB_DIR || join(homeDir, ".agent-hub"));
    case "agent-home":
      return (
        firstExistingDir([
          env.OPC_AGENT_HOME_STATE_DIR,
          resolve(root, "../agent-home/.agent-state"),
          resolve(root, "../ppeng-agent-core/.agent-state"),
          resolve(root, "../../self-test-grounding/ppeng-agent-core/.agent-state"),
        ]) || resolve(root, "../agent-home/.agent-state")
      );
    default:
      throw new Error(`未知槽位无法映射到本机路径：${slotMeta.id}（请传入 --target-root 指定目标目录）`);
  }
}

export function restoreBackup({
  archivePath,
  rootDir = REPO_ROOT,
  homeDir = homedir(),
  env = process.env,
  targetRoot = "",
  apply = false,
  passphrase = "",
  passphraseFile = "",
} = {}) {
  const resolvedPassphrase = resolvePassphrase({ passphrase, passphraseFile, env });
  const { workDir, extractDir, encrypted } = extractArchiveToTemp(archivePath, resolvedPassphrase);
  try {
    const verification = verifyExtractedArchive(extractDir, encrypted);
    if (!verification.ok || !verification.manifest) {
      throw new Error(`拒绝恢复：备份包未通过完整性校验（${verification.errors.join("；")}）`);
    }

    const manifest = verification.manifest;
    const slotMap = new Map((manifest.slots ?? []).map(s => [s.id, s]));
    const ts = formatTimestamp();
    const restoredFiles = [];
    const backedUpExisting = [];
    const warnings = [];
    const slotsRoot = join(extractDir, "slots");
    const realSlotsRoot = realpathSync(slotsRoot);

    for (const item of manifest.files) {
      const slotMeta = slotMap.get(item.slotId);
      if (!slotMeta) throw new Error(`manifest 缺少槽位定义：${item.slotId}`);
      const safeRel = assertSafeRelPath(item.relativePath, `restore ${item.slotId}`);
      const verifiedSrc = assertVerifiedExtractedFile(slotsRoot, realSlotsRoot, item.slotId, safeRel);
      if (!verifiedSrc.exists) {
        throw new Error(`恢复源文件缺失：${item.slotId}/${safeRel}`);
      }
      const srcPath = verifiedSrc.filePath;
      const slotDestDir = resolveRestoreSlotDir(slotMeta, { rootDir, homeDir, env, targetRoot });
      const destPath = assertWithinDir(slotDestDir, join(slotDestDir, ...safeRel.split("/")));
      const existed = existsSync(destPath);

      if (apply) {
        mkdirSync(dirname(destPath), { recursive: true });
        if (existed) {
          const backupCopy = `${destPath}.pre-restore-${ts}`;
          renameSync(destPath, backupCopy);
          backedUpExisting.push({ original: destPath, backup: backupCopy });
        }
        // Move away stale SQLite WAL/SHM sidecars so SQLite never replays old WAL onto a restored DB
        if (item.kind === "sqlite") {
          for (const suffix of ["-wal", "-shm", "-journal"]) {
            const sidecar = `${destPath}${suffix}`;
            if (existsSync(sidecar)) {
              const movedSidecar = `${destPath}.pre-restore-${ts}${suffix}`;
              renameSync(sidecar, movedSidecar);
              backedUpExisting.push({ original: sidecar, backup: movedSidecar });
            }
          }
        }
        copyFileSync(srcPath, destPath);
        if (typeof item.mode === "number" && item.mode > 0) {
          try {
            chmodSync(destPath, item.mode);
          } catch {
            // ignore chmod issues on exotic filesystems
          }
        }
      }

      if (item.slotId === "opc-os-local" && safeRel === "service.env") {
        const content = readFileSync(srcPath, "utf8");
        const m = /DATA_PATH="?([^"\n]+)"?/.exec(content);
        if (m && m[1] && resolve(m[1]) !== resolve(dirname(destPath), "chatroom.db")) {
          warnings.push(
            `service.env 中的 DATA_PATH 指向旧目录（如迁移到了新路径，请更新 ${destPath} 中的 DATA_PATH 或删除 service.env 让 opc:start 重新生成）。`,
          );
        }
      }

      restoredFiles.push({
        slotId: item.slotId,
        relativePath: safeRel,
        kind: item.kind,
        size: item.size,
        destPath,
        willOverwrite: existed,
      });
    }

    return {
      ok: true,
      dryRun: !apply,
      applied: Boolean(apply),
      encrypted,
      fileCount: restoredFiles.length,
      restoredFiles,
      backedUpExisting,
      warnings,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function listBackups({ rootDir = REPO_ROOT, backupDir = "" } = {}) {
  const dir = backupDir ? resolve(backupDir) : join(resolve(rootDir), "data", "backups");
  if (!existsSync(dir)) return { dir, backups: [] };
  const files = readdirSync(dir)
    .filter(name => name.endsWith(".tar.gz") || name.endsWith(".tar.gz.enc"))
    .map(name => {
      const abs = join(dir, name);
      const st = statSync(abs);
      return {
        name,
        path: abs,
        encrypted: name.endsWith(".enc") || isEncryptedArchive(abs),
        sizeBytes: st.size,
        modifiedAt: st.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return { dir, backups: files };
}

function parseCliArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    if (["encrypt", "full", "include-hub", "include-agent-home", "no-verify", "apply", "dry-run", "json", "help"].includes(key)) {
      flags[key] = true;
    } else if (i + 1 < argv.length) {
      flags[key] = argv[++i];
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

const USAGE = `OPC OS 数据主权一键热备、校验与安全迁移工具

用法:
  node scripts/opc-backup.mjs backup  [--out <路径>] [--encrypt] [--passphrase-file <文件>] [--full] [--include-hub] [--include-agent-home] [--json]
  node scripts/opc-backup.mjs verify  <备份文件> [--passphrase-file <文件>] [--json]
  node scripts/opc-backup.mjs restore <备份文件> [--target-root <目标目录>] [--apply] [--passphrase-file <文件>] [--json]
  node scripts/opc-backup.mjs list    [--dir <目录>] [--json]

说明:
  - 默认 backup 热备 OPC OS 主库 + 商业/GTM/客服/分析全部主权库（对活跃 WAL SQLite 执行 VACUUM INTO 无损热备），输出至 gitignored 的 data/backups/。
  - 传入 --full 额外纳入本机 Agent Hub 与 Agent Home 运行态主库（适合整机换机迁移）。
  - 传入 --encrypt 使用 AES-256-GCM 加密为 .tar.gz.enc（口令取自环境变量 OPC_BACKUP_PASSPHRASE 或 --passphrase-file）。
  - restore 默认仅做 dry-run 预演，传入 --apply 才会落盘，并自动留存旧文件为 .pre-restore-<时间> 副本。`;

function runCli() {
  const { positional, flags } = parseCliArgs(process.argv.slice(2));
  const cmd = positional[0] || "help";
  if (flags.help || cmd === "help" || cmd === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  try {
    if (cmd === "backup") {
      const result = createBackup({
        outPath: typeof flags.out === "string" ? flags.out : "",
        backupDir: typeof flags.dir === "string" ? flags.dir : "",
        encrypt: Boolean(flags.encrypt),
        passphraseFile: typeof flags["passphrase-file"] === "string" ? flags["passphrase-file"] : "",
        full: Boolean(flags.full),
        includeHub: Boolean(flags["include-hub"]),
        includeAgentHome: Boolean(flags["include-agent-home"]),
        verify: !flags["no-verify"],
      });
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`✅ OPC 数据主权热备完成${result.encrypted ? "（AES-256-GCM 已加密）" : ""}`);
        console.log(`   归档文件: ${result.archivePath}`);
        console.log(
          `   归档体积: ${formatBytes(result.archiveSizeBytes)} | 文件数: ${result.fileCount}（含 SQLite 热备 ${result.sqliteCount} 个） | 自检: ${result.verified ? "PASS" : "SKIPPED"}`,
        );
        console.log("   覆盖槽位:");
        for (const s of result.slots) {
          console.log(`     - ${s.id} (${s.label}): ${s.fileCount} 个文件, ${formatBytes(s.sizeBytes)}`);
        }
      }
      return;
    }

    if (cmd === "verify") {
      const archive = positional[1];
      if (!archive) throw new Error("请指定需要校验的备份文件路径");
      const result = verifyBackup({
        archivePath: archive,
        passphraseFile: typeof flags["passphrase-file"] === "string" ? flags["passphrase-file"] : "",
      });
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.ok) {
        console.log(`✅ 校验通过${result.encrypted ? "（已解密验证）" : ""}`);
        console.log(`   已校验文件: ${result.checkedFiles} 个 | SQLite PRAGMA integrity_check: ${result.checkedSqlite} 个全绿`);
        console.log(`   创建时间: ${result.manifest?.createdAt}`);
      } else {
        console.error("❌ 备份校验失败:");
        for (const err of result.errors) console.error(`   - ${err}`);
      }
      if (!result.ok) process.exit(1);
      return;
    }

    if (cmd === "restore") {
      const archive = positional[1];
      if (!archive) throw new Error("请指定需要恢复的备份文件路径");
      const result = restoreBackup({
        archivePath: archive,
        targetRoot: typeof flags["target-root"] === "string" ? flags["target-root"] : "",
        apply: Boolean(flags.apply) && !flags["dry-run"],
        passphraseFile: typeof flags["passphrase-file"] === "string" ? flags["passphrase-file"] : "",
      });
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const header = result.dryRun
          ? "🧪 恢复预演（DRY-RUN，未写入磁盘；确认无误后加 --apply 执行）"
          : "✅ 数据恢复已完成";
        console.log(header);
        console.log(`   涉及文件: ${result.fileCount} 个${result.backedUpExisting.length ? ` | 已留存旧文件回滚副本: ${result.backedUpExisting.length} 个` : ""}`);
        for (const f of result.restoredFiles) {
          const tag = f.willOverwrite ? "[覆盖并留备]" : "[新建]";
          console.log(`     - ${tag} ${f.slotId}/${f.relativePath} -> ${f.destPath}`);
        }
        for (const w of result.warnings) {
          console.log(`   ⚠️  ${w}`);
        }
      }
      return;
    }

    if (cmd === "list") {
      const result = listBackups({ backupDir: typeof flags.dir === "string" ? flags.dir : "" });
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`备份目录: ${result.dir}（共 ${result.backups.length} 份）`);
        for (const b of result.backups) {
          console.log(`  - ${b.name} | ${formatBytes(b.sizeBytes)} | ${b.encrypted ? "加密" : "明文"} | ${b.modifiedAt}`);
        }
      }
      return;
    }

    console.error(`未知命令: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  runCli();
}
