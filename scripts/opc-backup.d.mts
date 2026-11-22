export interface BackupManifestSlot {
  id: string;
  label: string;
  scope: "workspace" | "home";
  targetRel: string;
  fileCount: number;
  sizeBytes: number;
}

export interface BackupManifestFile {
  slotId: string;
  relativePath: string;
  kind: "sqlite" | "file";
  size: number;
  mode: number;
  sha256: string;
  integrity?: string;
}

export interface BackupManifest {
  schemaVersion: number;
  tool: string;
  createdAt: string;
  full: boolean;
  includeHub: boolean;
  includeAgentHome: boolean;
  fileCount: number;
  sqliteCount: number;
  totalSourceBytes: number;
  slots: BackupManifestSlot[];
  files: BackupManifestFile[];
}

export interface CreateBackupOptions {
  rootDir?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  outPath?: string;
  backupDir?: string;
  encrypt?: boolean;
  passphrase?: string;
  passphraseFile?: string;
  full?: boolean;
  includeHub?: boolean;
  includeAgentHome?: boolean;
  verify?: boolean;
}

export interface CreateBackupResult {
  ok: boolean;
  archivePath: string;
  encrypted: boolean;
  archiveSizeBytes: number;
  fileCount: number;
  sqliteCount: number;
  slots: BackupManifestSlot[];
  verified: boolean;
  manifest: BackupManifest;
}

export interface VerifyBackupOptions {
  archivePath: string;
  passphrase?: string;
  passphraseFile?: string;
  env?: Record<string, string | undefined>;
}

export interface VerifyBackupResult {
  ok: boolean;
  encrypted: boolean;
  manifest: BackupManifest | null;
  checkedFiles: number;
  checkedSqlite: number;
  errors: string[];
}

export interface RestoreBackupOptions {
  archivePath: string;
  rootDir?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  targetRoot?: string;
  apply?: boolean;
  passphrase?: string;
  passphraseFile?: string;
}

export interface RestoreBackupResult {
  ok: boolean;
  dryRun: boolean;
  applied: boolean;
  encrypted: boolean;
  fileCount: number;
  restoredFiles: Array<{
    slotId: string;
    relativePath: string;
    kind: "sqlite" | "file";
    size: number;
    destPath: string;
    willOverwrite: boolean;
  }>;
  backedUpExisting: Array<{ original: string; backup: string }>;
  warnings: string[];
}

export interface ListBackupsResult {
  dir: string;
  backups: Array<{
    name: string;
    path: string;
    encrypted: boolean;
    sizeBytes: number;
    modifiedAt: string;
  }>;
}

export function encryptBuffer(plainBuffer: Buffer, passphrase: string): Buffer;
export function decryptBuffer(encBuffer: Buffer, passphrase: string): Buffer;
export function createBackup(options?: CreateBackupOptions): CreateBackupResult;
export function verifyBackup(options: VerifyBackupOptions): VerifyBackupResult;
export function restoreBackup(options: RestoreBackupOptions): RestoreBackupResult;
export function listBackups(options?: { rootDir?: string; backupDir?: string }): ListBackupsResult;
