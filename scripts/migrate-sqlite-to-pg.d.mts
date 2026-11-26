export interface MigrateTableReconciliation {
  table: string;
  sqliteRows: number;
  pgRows: number;
  matched: boolean;
}

export interface MigrateSqliteToPgOptions {
  sqlitePath?: string;
  pgUrl?: string;
  schema?: string;
  truncate?: boolean;
  batchSize?: number;
}

export interface MigrateSqliteToPgResult {
  ok: boolean;
  sqlitePath: string;
  schema: string;
  tableCount: number;
  indexCount: number;
  triggerCount: number;
  matchedTables: number;
  mismatchedTables: number;
  totalSqliteRows: number;
  totalPgRows: number;
  mismatches: MigrateTableReconciliation[];
  tables: MigrateTableReconciliation[];
}

export function migrateSqliteToPg(options?: MigrateSqliteToPgOptions): Promise<MigrateSqliteToPgResult>;
