import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createBackup,
  decryptBuffer,
  encryptBuffer,
  listBackups,
  restoreBackup,
  verifyBackup,
} from "../scripts/opc-backup.mjs";

function makeTempWorkspace() {
  const base = mkdtempSync(join(tmpdir(), "opc-backup-test-"));
  const opcOsDir = join(base, "opc-os");
  const localDir = join(opcOsDir, "data", "zoom-local");
  const commerceDir = join(base, "opc-commerce-kit", "data");
  const gtmDir = join(base, "opc-gtm-kit", "data");
  const opsDir = join(base, "opc-ops-kit", "data");
  const analyticsDir = join(base, "data_analysis", "data");
  const homeDir = join(base, "fake-home");
  const hubDir = join(homeDir, ".agent-hub");

  for (const dir of [localDir, commerceDir, gtmDir, opsDir, analyticsDir, hubDir]) {
    mkdirSync(dir, { recursive: true });
  }

  // Open WAL-mode live SQLite DB and keep writing without full checkpoint to verify online hot-backup
  const liveDbPath = join(localDir, "chatroom.db");
  const liveDb = new DatabaseSync(liveDbPath);
  liveDb.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    INSERT INTO notes(body) VALUES ('initial-row'), ('wal-only-live-row');
  `);

  writeFileSync(
    join(localDir, "service.env"),
    `PORT="52328"\nDATA_PATH="${liveDbPath}"\nWORKFLOW_SUBMIT_TOKEN="test-token-0123456789abcdef"\n`,
    { mode: 0o600 },
  );
  // Stale backup snapshot inside zoom-local MUST be excluded
  writeFileSync(join(localDir, "before-legacy.db"), "stale-snapshot");

  const initSimpleDb = (filePath: string, table: string, val: string) => {
    const db = new DatabaseSync(filePath);
    db.exec(`CREATE TABLE ${table}(k TEXT PRIMARY KEY, v TEXT); INSERT INTO ${table} VALUES ('sample', '${val}');`);
    db.close();
  };

  initSimpleDb(join(commerceDir, "commerce.db"), "licenses", "ed25519-key-material");
  writeFileSync(join(commerceDir, "signing-meta.json"), JSON.stringify({ keyId: "abc123def456" }), { mode: 0o600 });
  initSimpleDb(join(gtmDir, "gtm.db"), "leads", "utm_source=demo");
  initSimpleDb(join(opsDir, "opc-ops.db"), "tickets", "ticket-1");
  initSimpleDb(join(analyticsDir, "catalog_metadata.db"), "tables_meta", "funnel_v1");
  // DuckDB pair MUST both be preserved, while test_*.db MUST be skipped
  writeFileSync(join(analyticsDir, "analytics_events.duckdb"), "DUCKDB_FAKE_HEADER");
  writeFileSync(join(analyticsDir, "analytics_events.duckdb.wal"), "DUCKDB_WAL_DATA");
  initSimpleDb(join(analyticsDir, "test_scratch.db"), "scratch", "ignore-me");

  // Optional Agent Hub slot
  initSimpleDb(join(hubDir, "hub.db"), "quota", "plan-ok");
  writeFileSync(join(hubDir, "plans.json"), JSON.stringify({ plans: ["demo"] }));
  writeFileSync(join(hubDir, "hub.lock"), "");

  return { base, opcOsDir, localDir, commerceDir, analyticsDir, homeDir, liveDb };
}

test("createBackup performs live WAL SQLite hot-backup, verifies integrity, and restores safely", () => {
  const ws = makeTempWorkspace();
  const restoreTarget = mkdtempSync(join(tmpdir(), "opc-restore-target-"));
  try {
    // Backup while liveDb is STILL OPEN with uncommitted-to-main WAL pages!
    const backup = createBackup({
      rootDir: ws.opcOsDir,
      homeDir: ws.homeDir,
      env: {},
      verify: true,
    });
    assert.equal(backup.ok, true);
    assert.equal(backup.verified, true);
    assert.equal(backup.encrypted, false);
    assert.equal(backup.sqliteCount, 5);
    assert.ok(existsSync(backup.archivePath));
    assert.equal(statSync(backup.archivePath).mode & 0o777, 0o600);

    // Ensure privacy: manifest never leaks absolute host directory paths
    const manifestText = JSON.stringify(backup.manifest);
    assert.ok(!manifestText.includes(ws.base), "manifest must not contain absolute workspace paths");
    assert.ok(!manifestText.includes(ws.homeDir), "manifest must not contain home dir paths");

    // Ensure filtering worked accurately
    const keys = new Set(backup.manifest.files.map(f => `${f.slotId}/${f.relativePath}`));
    assert.ok(keys.has("opc-os-local/chatroom.db"));
    assert.ok(keys.has("opc-os-local/service.env"));
    assert.ok(keys.has("opc-commerce/commerce.db"));
    assert.ok(keys.has("opc-commerce/signing-meta.json"));
    assert.ok(keys.has("opc-gtm/gtm.db"));
    assert.ok(keys.has("opc-ops/opc-ops.db"));
    assert.ok(keys.has("opc-analytics/catalog_metadata.db"));
    assert.ok(keys.has("opc-analytics/analytics_events.duckdb"));
    assert.ok(keys.has("opc-analytics/analytics_events.duckdb.wal"));
    assert.ok(!keys.has("opc-os-local/before-legacy.db"));
    assert.ok(!keys.has("opc-os-local/chatroom.db-wal"));
    assert.ok(!keys.has("opc-analytics/test_scratch.db"));
    assert.ok(!keys.has("agent-hub/hub.db"), "agent-hub excluded unless --full / --include-hub");

    // List backups finds it
    const listed = listBackups({ rootDir: ws.opcOsDir });
    assert.equal(listed.backups.length, 1);
    assert.equal(listed.backups[0].encrypted, false);

    // Dry-run restore writes nothing
    const dry = restoreBackup({
      archivePath: backup.archivePath,
      targetRoot: restoreTarget,
      apply: false,
    });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.applied, false);
    assert.equal(readdirSync(restoreTarget).length, 0);
    assert.ok(dry.warnings.some(w => w.includes("DATA_PATH")));

    // Real restore writes cleanly inside restoreTarget and preserves WAL-only rows
    const applied = restoreBackup({
      archivePath: backup.archivePath,
      targetRoot: restoreTarget,
      apply: true,
    });
    assert.equal(applied.dryRun, false);
    assert.equal(applied.applied, true);
    const restoredDbPath = join(restoreTarget, "opc-os", "data", "zoom-local", "chatroom.db");
    assert.ok(existsSync(restoredDbPath));
    const checkDb = new DatabaseSync(restoredDbPath, { readOnly: true });
    try {
      const rows = checkDb.prepare("SELECT body FROM notes ORDER BY id").all() as Array<{ body: string }>;
      assert.deepEqual(
        rows.map(r => r.body),
        ["initial-row", "wal-only-live-row"],
      );
    } finally {
      checkDb.close();
    }

    // Second restore over existing DB with stale -wal/-shm moves old DB + sidecars aside safely
    writeFileSync(`${restoredDbPath}-wal`, "STALE_WAL_GARBAGE");
    writeFileSync(`${restoredDbPath}-shm`, "STALE_SHM_GARBAGE");
    const second = restoreBackup({
      archivePath: backup.archivePath,
      targetRoot: restoreTarget,
      apply: true,
    });
    assert.ok(second.backedUpExisting.some(b => b.original === restoredDbPath));
    assert.ok(second.backedUpExisting.some(b => b.original === `${restoredDbPath}-wal`));
    assert.equal(existsSync(`${restoredDbPath}-wal`), false, "stale WAL sidecar must be moved aside");
    assert.equal(existsSync(`${restoredDbPath}-shm`), false, "stale SHM sidecar must be moved aside");
  } finally {
    ws.liveDb.close();
    rmSync(ws.base, { recursive: true, force: true });
    rmSync(restoreTarget, { recursive: true, force: true });
  }
});

test("encrypted backup (--encrypt) roundtrips cleanly and rejects wrong passphrase or tampering", () => {
  const ws = makeTempWorkspace();
  const restoreTarget = mkdtempSync(join(tmpdir(), "opc-restore-enc-"));
  try {
    assert.throws(
      () =>
        createBackup({
          rootDir: ws.opcOsDir,
          homeDir: ws.homeDir,
          env: {},
          encrypt: true,
        }),
      /口令/,
    );

    const enc = createBackup({
      rootDir: ws.opcOsDir,
      homeDir: ws.homeDir,
      env: {},
      encrypt: true,
      includeHub: true,
      passphrase: "opc-sovereign-passphrase-2026",
    });
    assert.equal(enc.encrypted, true);
    assert.ok(enc.archivePath.endsWith(".tar.gz.enc"));
    assert.ok(enc.manifest.files.some(f => f.slotId === "agent-hub" && f.relativePath === "hub.db"));

    // Verify succeeds with right passphrase
    const okVerify = verifyBackup({
      archivePath: enc.archivePath,
      passphrase: "opc-sovereign-passphrase-2026",
    });
    assert.equal(okVerify.ok, true);
    assert.equal(okVerify.encrypted, true);
    assert.equal(okVerify.checkedSqlite, 6);

    // Wrong passphrase fails
    assert.throws(
      () =>
        verifyBackup({
          archivePath: enc.archivePath,
          passphrase: "wrong-passphrase",
        }),
      /解密失败/,
    );

    // Restore with right passphrase works
    const restored = restoreBackup({
      archivePath: enc.archivePath,
      targetRoot: restoreTarget,
      passphrase: "opc-sovereign-passphrase-2026",
      apply: true,
    });
    assert.equal(restored.applied, true);
    assert.ok(existsSync(join(restoreTarget, ".agent-hub", "hub.db")));

    // Single-byte tampering fails GCM auth tag check
    const raw = Buffer.from(readFileSync(enc.archivePath));
    raw[raw.length - 1] ^= 0xff;
    const tamperedPath = `${enc.archivePath}.tampered.enc`;
    writeFileSync(tamperedPath, raw);
    assert.throws(
      () =>
        verifyBackup({
          archivePath: tamperedPath,
          passphrase: "opc-sovereign-passphrase-2026",
        }),
      /解密失败/,
    );
  } finally {
    ws.liveDb.close();
    rmSync(ws.base, { recursive: true, force: true });
    rmSync(restoreTarget, { recursive: true, force: true });
  }
});

test("verifyBackup detects SHA-256 file tampering and blocks unsafe restore", () => {
  const ws = makeTempWorkspace();
  const scratch = mkdtempSync(join(tmpdir(), "opc-tamper-"));
  try {
    const backup = createBackup({
      rootDir: ws.opcOsDir,
      homeDir: ws.homeDir,
      env: {},
      verify: true,
    });

    // Unpack, tamper with signing-meta.json, repack
    const unpackDir = join(scratch, "unpacked");
    mkdirSync(unpackDir, { recursive: true });
    execFileSync("tar", ["-xzf", backup.archivePath, "-C", unpackDir]);
    const targetFile = join(unpackDir, "slots", "opc-commerce", "signing-meta.json");
    chmodSync(targetFile, 0o600);
    writeFileSync(targetFile, JSON.stringify({ keyId: "TAMPERED_KEY" }));
    const tamperedTar = join(scratch, "tampered.tar.gz");
    execFileSync("tar", ["-czf", tamperedTar, "-C", unpackDir, "manifest.json", "slots"]);

    const check = verifyBackup({ archivePath: tamperedTar });
    assert.equal(check.ok, false);
    assert.ok(check.errors.some(e => e.includes("SHA-256") || e.includes("大小不匹配")));

    assert.throws(
      () => restoreBackup({ archivePath: tamperedTar, targetRoot: join(scratch, "out"), apply: true }),
      /拒绝恢复/,
    );

    // Path traversal inside manifest is rejected
    const manifestPath = join(unpackDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files[0].relativePath = "../escape.db";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const traversalTar = join(scratch, "traversal.tar.gz");
    execFileSync("tar", ["-czf", traversalTar, "-C", unpackDir, "manifest.json", "slots"]);
    const traversalCheck = verifyBackup({ archivePath: traversalTar });
    assert.equal(traversalCheck.ok, false);
    assert.ok(traversalCheck.errors.some(e => e.includes("路径穿越")));
  } finally {
    ws.liveDb.close();
    rmSync(ws.base, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("encryptBuffer / decryptBuffer roundtrip works directly", () => {
  const payload = Buffer.from("hello-sovereign-opc-data", "utf8");
  const enc = encryptBuffer(payload, "secret-key");
  assert.notDeepEqual(enc, payload);
  const dec = decryptBuffer(enc, "secret-key");
  assert.deepEqual(dec, payload);
});

test("createBackup captures live companion-runtime slots and rejects symlink tar attacks", () => {
  const ws = makeTempWorkspace();
  const scratch = mkdtempSync(join(tmpdir(), "opc-companion-symlink-"));
  const restoreTarget = mkdtempSync(join(tmpdir(), "opc-companion-restore-"));
  try {
    const rtCommerce = join(ws.opcOsDir, "data", "companion-runtime", "commerce");
    const rtGtm = join(ws.opcOsDir, "data", "companion-runtime", "gtm");
    mkdirSync(rtCommerce, { recursive: true });
    mkdirSync(rtGtm, { recursive: true });
    const rtDb = new DatabaseSync(join(rtCommerce, "commerce.db"));
    rtDb.exec("CREATE TABLE orders(id TEXT PRIMARY KEY); INSERT INTO orders VALUES ('ord_live_1');");
    rtDb.close();
    writeFileSync(join(rtCommerce, "ed25519.pem"), "PRIVATE_KEY_TEST", { mode: 0o600 });
    writeFileSync(join(rtCommerce, "pids.json"), JSON.stringify({ pid: 99999 }));
    const rtGtmDb = new DatabaseSync(join(rtGtm, "gtm.db"));
    rtGtmDb.exec("CREATE TABLE events(id TEXT PRIMARY KEY); INSERT INTO events VALUES ('evt_live_1');");
    rtGtmDb.close();

    const backup = createBackup({
      rootDir: ws.opcOsDir,
      homeDir: ws.homeDir,
      env: {},
      verify: true,
    });
    const keys = new Set(backup.manifest.files.map(f => `${f.slotId}/${f.relativePath}`));
    assert.ok(keys.has("opc-companion-commerce/commerce.db"));
    assert.ok(keys.has("opc-companion-commerce/ed25519.pem"));
    assert.ok(!keys.has("opc-companion-commerce/pids.json"), "ephemeral pids.json must be excluded");
    assert.ok(keys.has("opc-companion-gtm/gtm.db"));

    const restored = restoreBackup({
      archivePath: backup.archivePath,
      targetRoot: restoreTarget,
      apply: true,
    });
    assert.equal(restored.applied, true);
    assert.ok(existsSync(join(restoreTarget, "opc-os", "data", "companion-runtime", "commerce", "commerce.db")));

    // Repack archive with a symlink inside slots/ and confirm verifyBackup & restoreBackup block it
    const unpackDir = join(scratch, "unpacked");
    mkdirSync(unpackDir, { recursive: true });
    execFileSync("tar", ["-xzf", backup.archivePath, "-C", unpackDir]);
    symlinkSync("/etc/hosts", join(unpackDir, "slots", "opc-commerce", "evil-link"));
    const symlinkTar = join(scratch, "symlink-attack.tar.gz");
    execFileSync("tar", ["-czf", symlinkTar, "-C", unpackDir, "manifest.json", "slots"]);

    assert.throws(
      () => verifyBackup({ archivePath: symlinkTar }),
      /符号链接|非法文件/,
    );
    assert.throws(
      () => restoreBackup({ archivePath: symlinkTar, targetRoot: join(scratch, "out"), apply: true }),
      /拒绝恢复|符号链接|非法文件/,
    );
  } finally {
    ws.liveDb.close();
    rmSync(ws.base, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    rmSync(restoreTarget, { recursive: true, force: true });
  }
});
