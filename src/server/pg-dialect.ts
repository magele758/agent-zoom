export type SqlTokenKind =
  | "ws"
  | "comment"
  | "string"
  | "dquote"
  | "word"
  | "number"
  | "qmark"
  | "semi"
  | "op";

export interface SqlToken {
  kind: SqlTokenKind;
  value: string;
}

export type TranslatedStatementKind =
  | "sql"
  | "noop"
  | "begin"
  | "commit"
  | "rollback"
  | "pragma_query";

export interface TranslatedStatement {
  sql: string;
  extraSqls?: string[];
  kind: TranslatedStatementKind;
  insertTable?: string;
  hasReturning?: boolean;
}

const SQL_KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "NULL", "TRUE", "FALSE",
  "AS", "IN", "IS", "ON", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "CROSS",
  "FULL", "NATURAL", "BY", "ORDER", "GROUP", "HAVING", "LIMIT", "OFFSET",
  "ASC", "DESC", "NULLS", "FIRST", "LAST", "CASE", "WHEN", "THEN", "ELSE",
  "END", "CAST", "CREATE", "TABLE", "INDEX", "UNIQUE", "PRIMARY", "KEY",
  "FOREIGN", "REFERENCES", "CHECK", "DEFAULT", "CONSTRAINT", "IF", "EXISTS",
  "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CONFLICT", "DO",
  "NOTHING", "EXCLUDED", "RETURNING", "ALTER", "ADD", "COLUMN", "DROP",
  "BEGIN", "COMMIT", "ROLLBACK", "TRIGGER", "AFTER", "BEFORE", "INSTEAD",
  "OF", "FOR", "EACH", "ROW", "NEW", "OLD", "INTEGER", "INT", "BIGINT",
  "SMALLINT", "BIGSERIAL", "SERIAL", "TEXT", "CITEXT", "VARCHAR", "CHAR",
  "REAL", "DOUBLE", "PRECISION", "NUMERIC", "DECIMAL", "FLOAT", "BOOLEAN",
  "BOOL", "BYTEA", "BLOB", "JSON", "JSONB", "TIMESTAMP", "TIMESTAMPTZ",
  "DATE", "TIME", "GENERATED", "ALWAYS", "STORED", "VIRTUAL", "COLLATE",
  "NOCASE", "AUTOINCREMENT", "GLOB", "LIKE", "ILIKE", "SIMILAR", "ESCAPE",
  "BETWEEN", "UNION", "ALL", "EXCEPT", "INTERSECT", "WITH", "RECURSIVE",
  "DISTINCT", "OVER", "PARTITION", "PRAGMA", "CASCADE", "RESTRICT", "NO",
  "ACTION", "TEMP", "TEMPORARY", "VIEW", "REPLACE", "IGNORE", "ABORT",
  "FAIL", "IMMEDIATE", "DEFERRED", "EXCLUSIVE", "TRANSACTION", "SAVEPOINT",
  "RELEASE", "TO", "USING", "LATERAL", "FILTER", "CURRENT_SCHEMA",
  "CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME", "ROWID", "CTID",
  "OID", "GREATEST", "LEAST", "COALESCE", "NULLIF", "COUNT", "SUM", "AVG",
  "MIN", "MAX", "LOWER", "UPPER", "LENGTH", "SUBSTR", "SUBSTRING", "TRIM",
  "LTRIM", "RTRIM", "INSTR", "STRPOS", "ROUND", "ABS", "RANDOM",
]);

const SQLITE_MASTER_SUBQUERY =
  "(SELECT 'table'::text AS type, table_name::text AS name, table_name::text AS tbl_name, ''::text AS sql " +
  "FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' " +
  "UNION ALL " +
  "SELECT 'index'::text AS type, indexname::text AS name, tablename::text AS tbl_name, indexdef::text AS sql " +
  "FROM pg_indexes WHERE schemaname = current_schema()) AS sqlite_master";

export const PG_COMPAT_BOOTSTRAP_SQL = `
CREATE OR REPLACE FUNCTION public.instr(haystack text, needle text)
RETURNS integer
LANGUAGE sql
IMMUTABLE STRICT
AS $$
  SELECT strpos(haystack, needle);
$$;

CREATE OR REPLACE FUNCTION public.json_valid(doc text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF doc IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM doc::jsonb;
  RETURN TRUE;
EXCEPTION WHEN others THEN
  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public._opc_json_extract_jsonb(doc text, path text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  cur jsonb;
  p text;
  i integer;
  n integer;
  ch text;
  seg text;
  idx integer;
  j integer;
BEGIN
  IF doc IS NULL OR path IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    cur := doc::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;

  p := btrim(path);
  IF p = '$' OR p = '' THEN
    RETURN cur;
  END IF;
  IF left(p, 1) <> '$' THEN
    RETURN NULL;
  END IF;

  i := 2;
  n := char_length(p);
  WHILE i <= n LOOP
    ch := substr(p, i, 1);
    IF ch = '.' THEN
      i := i + 1;
      IF i > n THEN
        RETURN NULL;
      END IF;
      IF substr(p, i, 1) = '"' THEN
        i := i + 1;
        seg := '';
        WHILE i <= n LOOP
          ch := substr(p, i, 1);
          IF ch = '\\' AND i < n THEN
            seg := seg || substr(p, i + 1, 1);
            i := i + 2;
          ELSIF ch = '"' THEN
            i := i + 1;
            EXIT;
          ELSE
            seg := seg || ch;
            i := i + 1;
          END IF;
        END LOOP;
      ELSE
        j := i;
        WHILE j <= n AND substr(p, j, 1) NOT IN ('.', '[') LOOP
          j := j + 1;
        END LOOP;
        seg := substr(p, i, j - i);
        i := j;
      END IF;
      IF cur IS NULL OR jsonb_typeof(cur) <> 'object' OR NOT (cur ? seg) THEN
        RETURN NULL;
      END IF;
      cur := cur -> seg;
    ELSIF ch = '[' THEN
      i := i + 1;
      j := i;
      WHILE j <= n AND substr(p, j, 1) <> ']' LOOP
        j := j + 1;
      END LOOP;
      IF j > n THEN
        RETURN NULL;
      END IF;
      seg := substr(p, i, j - i);
      i := j + 1;
      IF seg !~ '^[0-9]+$' THEN
        RETURN NULL;
      END IF;
      idx := seg::integer;
      IF cur IS NULL OR jsonb_typeof(cur) <> 'array' THEN
        RETURN NULL;
      END IF;
      cur := cur -> idx;
      IF cur IS NULL THEN
        RETURN NULL;
      END IF;
    ELSE
      RETURN NULL;
    END IF;
  END LOOP;

  RETURN cur;
END;
$$;

CREATE OR REPLACE FUNCTION public.json_extract(doc text, path text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  cur jsonb;
  t text;
BEGIN
  cur := public._opc_json_extract_jsonb(doc, path);
  IF cur IS NULL THEN
    RETURN NULL;
  END IF;
  t := jsonb_typeof(cur);
  IF t = 'null' THEN
    RETURN NULL;
  ELSIF t = 'string' OR t = 'number' THEN
    RETURN cur #>> '{}';
  ELSIF t = 'boolean' THEN
    IF (cur #>> '{}') = 'true' THEN
      RETURN '1';
    ELSE
      RETURN '0';
    END IF;
  ELSE
    RETURN cur::text;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.json_array_length(doc text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  cur jsonb;
BEGIN
  IF doc IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    cur := doc::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF jsonb_typeof(cur) <> 'array' THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_array_length(cur);
END;
$$;

CREATE OR REPLACE FUNCTION public.json_array_length(doc text, path text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  cur jsonb;
BEGIN
  cur := public._opc_json_extract_jsonb(doc, path);
  IF cur IS NULL OR jsonb_typeof(cur) <> 'array' THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_array_length(cur);
END;
$$;

CREATE OR REPLACE FUNCTION public.json_each(doc text)
RETURNS TABLE(key text, value text, type text)
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  cur jsonb;
  t text;
BEGIN
  IF doc IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    cur := doc::jsonb;
  EXCEPTION WHEN others THEN
    RETURN;
  END;
  t := jsonb_typeof(cur);
  IF t = 'array' THEN
    RETURN QUERY
      SELECT (e.ord - 1)::text AS key,
             CASE
               WHEN jsonb_typeof(e.val) = 'null' THEN NULL
               WHEN jsonb_typeof(e.val) IN ('string', 'number') THEN e.val #>> '{}'
               WHEN jsonb_typeof(e.val) = 'boolean' THEN CASE WHEN (e.val #>> '{}') = 'true' THEN '1' ELSE '0' END
               ELSE e.val::text
             END AS value,
             jsonb_typeof(e.val) AS type
      FROM jsonb_array_elements(cur) WITH ORDINALITY AS e(val, ord);
  ELSIF t = 'object' THEN
    RETURN QUERY
      SELECT e.k AS key,
             CASE
               WHEN jsonb_typeof(e.val) = 'null' THEN NULL
               WHEN jsonb_typeof(e.val) IN ('string', 'number') THEN e.val #>> '{}'
               WHEN jsonb_typeof(e.val) = 'boolean' THEN CASE WHEN (e.val #>> '{}') = 'true' THEN '1' ELSE '0' END
               ELSE e.val::text
             END AS value,
             jsonb_typeof(e.val) AS type
      FROM jsonb_each(cur) AS e(k, val);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.json_set(doc text, path text, val text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  cur jsonb;
  p text;
  segs text[] := ARRAY[]::text[];
  i integer;
  n integer;
  ch text;
  seg text;
  j integer;
BEGIN
  IF doc IS NULL OR path IS NULL THEN
    RETURN NULL;
  END IF;
  cur := doc::jsonb;
  p := btrim(path);
  IF p = '$' OR p = '' THEN
    RETURN to_jsonb(val)::text;
  END IF;
  IF left(p, 1) <> '$' THEN
    RETURN doc;
  END IF;
  i := 2;
  n := char_length(p);
  WHILE i <= n LOOP
    ch := substr(p, i, 1);
    IF ch = '.' THEN
      i := i + 1;
      j := i;
      WHILE j <= n AND substr(p, j, 1) NOT IN ('.', '[') LOOP
        j := j + 1;
      END LOOP;
      seg := substr(p, i, j - i);
      segs := array_append(segs, seg);
      i := j;
    ELSIF ch = '[' THEN
      i := i + 1;
      j := i;
      WHILE j <= n AND substr(p, j, 1) <> ']' LOOP
        j := j + 1;
      END LOOP;
      seg := substr(p, i, j - i);
      segs := array_append(segs, seg);
      i := j + 1;
    ELSE
      EXIT;
    END IF;
  END LOOP;
  IF val IS NULL THEN
    RETURN jsonb_set(cur, segs, 'null'::jsonb, true)::text;
  END IF;
  RETURN jsonb_set(cur, segs, to_jsonb(val), true)::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.sqlite_glob(val text, pattern text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  i integer := 1;
  n integer;
  ch text;
  rx text := '^';
  in_class boolean := false;
BEGIN
  IF val IS NULL OR pattern IS NULL THEN
    RETURN NULL;
  END IF;
  n := char_length(pattern);
  WHILE i <= n LOOP
    ch := substr(pattern, i, 1);
    IF in_class THEN
      IF ch = ']' THEN
        in_class := false;
        rx := rx || ']';
      ELSIF ch = '^' AND substr(pattern, i - 1, 1) = '[' THEN
        rx := rx || '^';
      ELSIF ch = '!' AND substr(pattern, i - 1, 1) = '[' THEN
        rx := rx || '^';
      ELSIF ch = '\\' THEN
        rx := rx || '\\\\';
      ELSE
        rx := rx || ch;
      END IF;
    ELSE
      IF ch = '*' THEN
        rx := rx || '.*';
      ELSIF ch = '?' THEN
        rx := rx || '.';
      ELSIF ch = '[' THEN
        in_class := true;
        rx := rx || '[';
      ELSIF ch IN ('.', '^', '$', '+', '(', ')', '{', '}', '|', '\\') THEN
        rx := rx || '\\' || ch;
      ELSE
        rx := rx || ch;
      END IF;
    END IF;
    i := i + 1;
  END LOOP;
  rx := rx || '$';
  RETURN val ~ rx;
END;
$$;
`;

export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") {
      let j = i + 1;
      while (j < n && (sql[j] === " " || sql[j] === "\t" || sql[j] === "\n" || sql[j] === "\r" || sql[j] === "\f")) {
        j++;
      }
      tokens.push({ kind: "ws", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    // Line comment --
    if (ch === "-" && sql[i + 1] === "-") {
      let j = i + 2;
      while (j < n && sql[j] !== "\n") j++;
      tokens.push({ kind: "comment", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    // Block comment /* ... */
    if (ch === "/" && sql[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(sql[j] === "*" && sql[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      tokens.push({ kind: "comment", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    // Single-quoted string literal
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      tokens.push({ kind: "string", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      tokens.push({ kind: "dquote", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    // Backtick-quoted identifier (SQLite compat -> PG double quotes)
    if (ch === "`") {
      let j = i + 1;
      while (j < n && sql[j] !== "`") j++;
      const inner = sql.slice(i + 1, j).replaceAll('"', '""');
      j = Math.min(n, j + 1);
      tokens.push({ kind: "dquote", value: `"${inner}"` });
      i = j;
      continue;
    }

    // Word / identifier
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_") {
      let j = i + 1;
      while (
        j < n &&
        ((sql[j] >= "a" && sql[j] <= "z") ||
          (sql[j] >= "A" && sql[j] <= "Z") ||
          (sql[j] >= "0" && sql[j] <= "9") ||
          sql[j] === "_")
      ) {
        j++;
      }
      tokens.push({ kind: "word", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    // Number
    if (ch >= "0" && ch <= "9") {
      let j = i + 1;
      while (j < n && sql[j] >= "0" && sql[j] <= "9") j++;
      if (sql[j] === "." && j + 1 < n && sql[j + 1] >= "0" && sql[j + 1] <= "9") {
        j++;
        while (j < n && sql[j] >= "0" && sql[j] <= "9") j++;
      }
      tokens.push({ kind: "number", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    // Placeholder ?
    if (ch === "?") {
      tokens.push({ kind: "qmark", value: "?" });
      i++;
      continue;
    }

    // Semicolon
    if (ch === ";") {
      tokens.push({ kind: "semi", value: ";" });
      i++;
      continue;
    }

    // Multi-char operators
    const two = sql.slice(i, i + 2);
    const three = sql.slice(i, i + 3);
    if (three === "#>>" || three === "->>") {
      tokens.push({ kind: "op", value: three });
      i += 3;
      continue;
    }
    if (
      two === "<>" ||
      two === "!=" ||
      two === "<=" ||
      two === ">=" ||
      two === "||" ||
      two === "::" ||
      two === "->"
    ) {
      tokens.push({ kind: "op", value: two });
      i += 2;
      continue;
    }

    tokens.push({ kind: "op", value: ch });
    i++;
  }

  return tokens;
}

function isTrivia(t: SqlToken): boolean {
  return t.kind === "ws" || t.kind === "comment";
}

function nextSig(tokens: SqlToken[], from: number): number {
  let i = from;
  while (i < tokens.length && isTrivia(tokens[i])) i++;
  return i;
}

function prevSig(tokens: SqlToken[], from: number): number {
  let i = from;
  while (i >= 0 && isTrivia(tokens[i])) i--;
  return i;
}

function sigIndices(tokens: SqlToken[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isTrivia(tokens[i])) out.push(i);
  }
  return out;
}

function wordIs(t: SqlToken | undefined, kw: string): boolean {
  return Boolean(t && t.kind === "word" && t.value.toUpperCase() === kw);
}

function joinTokens(tokens: SqlToken[]): string {
  return tokens.map((t) => t.value).join("");
}

/**
 * Split multi-statement SQLite SQL into individual statements, keeping
 * `CREATE TRIGGER ... BEGIN ... END;` blocks intact.
 */
export function splitSqlStatements(sql: string): string[] {
  const tokens = tokenizeSql(sql);
  const statements: string[] = [];
  let start = 0;
  let parenDepth = 0;
  let inTrigger = false;
  let triggerBodyDepth = 0;
  let caseDepth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (isTrivia(t)) continue;

    if (t.kind === "op") {
      if (t.value === "(") parenDepth++;
      else if (t.value === ")" && parenDepth > 0) parenDepth--;
      continue;
    }

    if (t.kind === "word") {
      const upper = t.value.toUpperCase();
      if (upper === "CREATE" && parenDepth === 0 && !inTrigger) {
        const n1 = nextSig(tokens, i + 1);
        const n2 = n1 < tokens.length ? nextSig(tokens, n1 + 1) : tokens.length;
        if (
          wordIs(tokens[n1], "TRIGGER") ||
          ((wordIs(tokens[n1], "TEMP") || wordIs(tokens[n1], "TEMPORARY")) && wordIs(tokens[n2], "TRIGGER"))
        ) {
          inTrigger = true;
        }
      } else if (inTrigger && parenDepth === 0) {
        if (upper === "BEGIN") {
          triggerBodyDepth++;
        } else if (upper === "CASE") {
          caseDepth++;
        } else if (upper === "END") {
          if (caseDepth > 0) {
            caseDepth--;
          } else if (triggerBodyDepth > 0) {
            triggerBodyDepth--;
            if (triggerBodyDepth === 0) {
              inTrigger = false;
            }
          }
        }
      }
      continue;
    }

    if (t.kind === "semi" && parenDepth === 0 && triggerBodyDepth === 0) {
      const chunk = joinTokens(tokens.slice(start, i)).trim();
      if (hasSignificantToken(tokens.slice(start, i))) {
        statements.push(chunk);
      }
      start = i + 1;
      inTrigger = false;
      caseDepth = 0;
    }
  }

  if (start < tokens.length) {
    const tail = tokens.slice(start);
    if (hasSignificantToken(tail)) {
      statements.push(joinTokens(tail).trim());
    }
  }

  return statements;
}

function hasSignificantToken(tokens: SqlToken[]): boolean {
  return tokens.some((t) => !isTrivia(t) && t.kind !== "semi");
}

function findMatchingCloseParen(tokens: SqlToken[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    if (tokens[i].kind === "op") {
      if (tokens[i].value === "(") depth++;
      else if (tokens[i].value === ")") {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

function findMatchingOpenParen(tokens: SqlToken[], closeIdx: number): number {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    if (tokens[i].kind === "op") {
      if (tokens[i].value === ")") depth++;
      else if (tokens[i].value === "(") {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

function hasTopLevelComma(tokens: SqlToken[], openIdx: number, closeIdx: number): boolean {
  let depth = 0;
  for (let i = openIdx + 1; i < closeIdx; i++) {
    const t = tokens[i];
    if (t.kind === "op") {
      if (t.value === "(") depth++;
      else if (t.value === ")") depth--;
      else if (t.value === "," && depth === 0) return true;
    }
  }
  return false;
}

function unquoteIdent(token: SqlToken): string {
  if (token.kind === "dquote") return token.value.slice(1, -1).replaceAll('""', '"');
  if (token.kind === "string") return token.value.slice(1, -1).replaceAll("''", "'");
  return token.value;
}

function isMixedCaseIdent(word: string): boolean {
  return /[a-z]/.test(word) && /[A-Z]/.test(word);
}

/**
 * Extract start index of an atomic SQL expression ending at `endIdx`
 * (supports identifiers, dotted refs, $1, strings, numbers, function calls, parenthesized exprs).
 */
function findExprStartBackward(tokens: SqlToken[], endIdx: number): number {
  const idx = prevSig(tokens, endIdx);
  if (idx < 0) return endIdx;
  const tok = tokens[idx];

  if (tok.kind === "op" && tok.value === ")") {
    const open = findMatchingOpenParen(tokens, idx);
    if (open < 0) return idx;
    const beforeOpen = prevSig(tokens, open - 1);
    if (beforeOpen >= 0 && (tokens[beforeOpen].kind === "word" || tokens[beforeOpen].kind === "dquote")) {
      const upper = tokens[beforeOpen].value.toUpperCase();
      if (!["IN", "AND", "OR", "NOT", "WHERE", "ON", "THEN", "ELSE", "WHEN", "CASE", "VALUES", "SET"].includes(upper)) {
        // Check for schema.fn(...)
        let start = beforeOpen;
        const maybeDot = prevSig(tokens, start - 1);
        if (maybeDot >= 0 && tokens[maybeDot].kind === "op" && tokens[maybeDot].value === ".") {
          const maybeSchema = prevSig(tokens, maybeDot - 1);
          if (maybeSchema >= 0 && (tokens[maybeSchema].kind === "word" || tokens[maybeSchema].kind === "dquote")) {
            start = maybeSchema;
          }
        }
        return start;
      }
    }
    return open;
  }

  // Handle `$1` or `$1::text` or `a.b`
  let start = idx;
  while (start > 0) {
    const p1 = prevSig(tokens, start - 1);
    if (p1 >= 0 && tokens[p1].kind === "op" && (tokens[p1].value === "." || tokens[p1].value === "::")) {
      const p2 = prevSig(tokens, p1 - 1);
      if (p2 >= 0) {
        if (tokens[p2].kind === "op" && tokens[p2].value === ")") {
          start = findExprStartBackward(tokens, p2);
          continue;
        }
        start = p2;
        continue;
      }
    }
    break;
  }
  return start;
}

/**
 * Extract end index of an atomic SQL expression starting at `startIdx`.
 */
function findExprEndForward(tokens: SqlToken[], startIdx: number): number {
  const idx = nextSig(tokens, startIdx);
  if (idx >= tokens.length) return startIdx;
  const tok = tokens[idx];

  if (tok.kind === "op" && tok.value === "(") {
    const close = findMatchingCloseParen(tokens, idx);
    return close >= 0 ? close : idx;
  }

  let end = idx;
  while (end + 1 < tokens.length) {
    const n1 = nextSig(tokens, end + 1);
    if (n1 >= tokens.length) break;
    if (tokens[n1].kind === "op" && tokens[n1].value === "(" && (tokens[end].kind === "word" || tokens[end].kind === "dquote")) {
      const close = findMatchingCloseParen(tokens, n1);
      if (close >= 0) {
        end = close;
        continue;
      }
    }
    if (tokens[n1].kind === "op" && (tokens[n1].value === "." || tokens[n1].value === "::")) {
      const n2 = nextSig(tokens, n1 + 1);
      if (n2 < tokens.length) {
        end = n2;
        continue;
      }
    }
    break;
  }
  return end;
}

/**
 * Translate a `CREATE TRIGGER` statement from SQLite syntax to PostgreSQL
 * trigger function + DROP TRIGGER + CREATE TRIGGER.
 */
function translateCreateTrigger(tokens: SqlToken[]): TranslatedStatement {
  const sigs = sigIndices(tokens);
  let pos = 0;
  // CREATE [TEMP|TEMPORARY] TRIGGER [IF NOT EXISTS] <name>
  pos++; // CREATE
  if (wordIs(tokens[sigs[pos]], "TEMP") || wordIs(tokens[sigs[pos]], "TEMPORARY")) pos++;
  pos++; // TRIGGER
  if (
    wordIs(tokens[sigs[pos]], "IF") &&
    wordIs(tokens[sigs[pos + 1]], "NOT") &&
    wordIs(tokens[sigs[pos + 2]], "EXISTS")
  ) {
    pos += 3;
  }
  const trigNameRaw = unquoteIdent(tokens[sigs[pos]]);
  pos++;

  // Timing: BEFORE | AFTER | INSTEAD OF
  const timingParts: string[] = [];
  if (wordIs(tokens[sigs[pos]], "BEFORE") || wordIs(tokens[sigs[pos]], "AFTER")) {
    timingParts.push(tokens[sigs[pos]].value.toUpperCase());
    pos++;
  } else if (wordIs(tokens[sigs[pos]], "INSTEAD") && wordIs(tokens[sigs[pos + 1]], "OF")) {
    timingParts.push("INSTEAD OF");
    pos += 2;
  } else {
    timingParts.push("AFTER");
  }

  // Event: INSERT | UPDATE [OF cols] | DELETE
  const eventStart = sigs[pos];
  const eventVerb = tokens[sigs[pos]].value.toUpperCase();
  while (pos < sigs.length && !wordIs(tokens[sigs[pos]], "ON")) pos++;
  const eventSql = joinTokens(tokens.slice(eventStart, sigs[pos])).trim();
  pos++; // ON

  const tableNameRaw = unquoteIdent(tokens[sigs[pos]]);
  pos++;

  // Skip optional FOR EACH ROW
  if (
    wordIs(tokens[sigs[pos]], "FOR") &&
    wordIs(tokens[sigs[pos + 1]], "EACH") &&
    wordIs(tokens[sigs[pos + 2]], "ROW")
  ) {
    pos += 3;
  }

  // Optional WHEN <expr> before BEGIN
  let whenSql: string | null = null;
  if (wordIs(tokens[sigs[pos]], "WHEN")) {
    const whenStart = sigs[pos] + 1;
    let pDepth = 0;
    while (pos < sigs.length) {
      const t = tokens[sigs[pos]];
      if (t.kind === "op" && t.value === "(") pDepth++;
      else if (t.kind === "op" && t.value === ")") pDepth--;
      else if (pDepth === 0 && wordIs(t, "BEGIN")) break;
      pos++;
    }
    const rawWhen = joinTokens(tokens.slice(whenStart, sigs[pos])).trim();
    whenSql = translateSingleStatement(rawWhen).sql;
  }

  // BEGIN <body> END
  const beginTokenIdx = sigs[pos];
  let endTokenIdx = tokens.length;
  for (let k = sigs.length - 1; k >= 0; k--) {
    if (wordIs(tokens[sigs[k]], "END")) {
      endTokenIdx = sigs[k];
      break;
    }
  }
  const rawBody = joinTokens(tokens.slice(beginTokenIdx + 1, endTokenIdx)).trim();
  const bodyStmts = splitSqlStatements(rawBody)
    .map((s) => {
      const raiseMatch = /^\s*SELECT\s+RAISE\s*\(\s*(?:ABORT|FAIL|ROLLBACK)\s*,\s*('(?:[^']|'')*')\s*\)\s*$/i.exec(s);
      if (raiseMatch) return `RAISE EXCEPTION ${raiseMatch[1]}`;
      if (/^\s*SELECT\s+RAISE\s*\(\s*IGNORE\s*\)\s*$/i.test(s)) return "RETURN NULL";
      return translateSingleStatement(s).sql;
    })
    .filter(Boolean);
  const returnRecord = eventVerb === "DELETE" ? "OLD" : "NEW";
  const fnName = `${trigNameRaw}_fn`;

  const indentedBody = bodyStmts.map((s) => `    ${s};`).join("\n");
  const fnBody = whenSql
    ? `  IF ${whenSql} THEN\n${indentedBody}\n  END IF;`
    : bodyStmts.map((s) => `  ${s};`).join("\n");

  const createFnSql = [
    `CREATE OR REPLACE FUNCTION ${fnName}() RETURNS TRIGGER AS $$`,
    `BEGIN`,
    fnBody,
    `  RETURN ${returnRecord};`,
    `END;`,
    `$$ LANGUAGE plpgsql`,
  ].join("\n");

  const dropTrigSql = `DROP TRIGGER IF EXISTS ${trigNameRaw} ON ${tableNameRaw}`;
  const createTrigSql = `CREATE TRIGGER ${trigNameRaw} ${timingParts.join(" ")} ${eventSql} ON ${tableNameRaw} FOR EACH ROW EXECUTE FUNCTION ${fnName}()`;

  return {
    sql: createFnSql,
    extraSqls: [dropTrigSql, createTrigSql],
    kind: "sql",
  };
}

/**
 * Translate CREATE TABLE / ALTER TABLE column definitions (COLLATE NOCASE -> CITEXT,
 * INTEGER PRIMARY KEY [AUTOINCREMENT] -> BIGSERIAL PRIMARY KEY, REAL -> DOUBLE PRECISION,
 * BLOB -> BYTEA, GENERATED ALWAYS AS (round(...)) STORED).
 */
function transformDdlTokens(tokens: SqlToken[], isCreateTable: boolean): SqlToken[] {
  // First pass: handle `GENERATED ALWAYS AS (...) STORED` round() numeric casting
  let out = [...tokens];

  if (isCreateTable) {
    // Find main column list parens after table name
    const openParen = out.findIndex((t) => t.kind === "op" && t.value === "(");
    if (openParen >= 0) {
      const closeParen = findMatchingCloseParen(out, openParen);
      if (closeParen > openParen) {
        const prefix = out.slice(0, openParen + 1);
        const body = out.slice(openParen + 1, closeParen);
        const suffix = out.slice(closeParen);
        const transformedBody = transformTableBodyColumns(body);
        out = [...prefix, ...transformedBody, ...suffix];
      }
    }
  } else {
    // ALTER TABLE ... ADD [COLUMN] <colDef>
    const addIdx = out.findIndex((t) => wordIs(t, "ADD"));
    if (addIdx >= 0) {
      let colStart = nextSig(out, addIdx + 1);
      if (wordIs(out[colStart], "COLUMN")) colStart = nextSig(out, colStart + 1);
      const prefix = out.slice(0, colStart);
      const colDef = transformSingleColumnDef(out.slice(colStart));
      out = [...prefix, ...colDef];
    }
  }

  return out;
}

function transformTableBodyColumns(bodyTokens: SqlToken[]): SqlToken[] {
  // Split bodyTokens by top-level commas
  const parts: SqlToken[][] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < bodyTokens.length; i++) {
    const t = bodyTokens[i];
    if (t.kind === "op") {
      if (t.value === "(") depth++;
      else if (t.value === ")") depth--;
      else if (t.value === "," && depth === 0) {
        parts.push(bodyTokens.slice(start, i));
        start = i + 1;
      }
    }
  }
  parts.push(bodyTokens.slice(start));

  const rebuilt: SqlToken[] = [];
  for (let p = 0; p < parts.length; p++) {
    if (p > 0) rebuilt.push({ kind: "op", value: "," });
    rebuilt.push(...transformSingleColumnDef(parts[p]));
  }
  return rebuilt;
}

function transformSingleColumnDef(part: SqlToken[]): SqlToken[] {
  const sigs = sigIndices(part);
  if (sigs.length === 0) return part;

  // Table-level constraints start with PRIMARY, UNIQUE, FOREIGN, CHECK, CONSTRAINT
  const firstUpper = part[sigs[0]].kind === "word" ? part[sigs[0]].value.toUpperCase() : "";
  if (["PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "CONSTRAINT"].includes(firstUpper)) {
    return part;
  }

  const out = part.map((t) => ({ ...t }));

  // Check if COLLATE NOCASE appears in this column definition
  let hasCollateNocase = false;
  for (let k = 0; k < sigs.length - 1; k++) {
    if (wordIs(out[sigs[k]], "COLLATE") && wordIs(out[sigs[k + 1]], "NOCASE")) {
      hasCollateNocase = true;
      out[sigs[k]].value = "";
      out[sigs[k + 1]].value = "";
      // Also collapse extra space before COLLATE if any
      if (sigs[k] > 0 && out[sigs[k] - 1].kind === "ws") {
        out[sigs[k] - 1].value = "";
      }
    }
  }

  // Check column type (second significant token in column def)
  if (sigs.length >= 2 && out[sigs[1]].kind === "word") {
    const typeUpper = out[sigs[1]].value.toUpperCase();
    if (hasCollateNocase && (typeUpper === "TEXT" || typeUpper === "VARCHAR" || typeUpper === "CHAR")) {
      out[sigs[1]].value = "CITEXT";
    } else if (typeUpper === "REAL") {
      out[sigs[1]].value = "DOUBLE PRECISION";
    } else if (typeUpper === "BLOB") {
      out[sigs[1]].value = "BYTEA";
    } else if (typeUpper === "INTEGER" || typeUpper === "INT") {
      // Check for PRIMARY KEY AUTOINCREMENT or standalone INTEGER PRIMARY KEY (without CHECK)
      const hasPk = sigs.some(
        (idx, pos) =>
          pos + 1 < sigs.length && wordIs(out[idx], "PRIMARY") && wordIs(out[sigs[pos + 1]], "KEY"),
      );
      const autoIdx = sigs.find((idx) => wordIs(out[idx], "AUTOINCREMENT"));
      const hasCheck = sigs.some((idx) => wordIs(out[idx], "CHECK"));
      if (hasPk && (autoIdx !== undefined || !hasCheck)) {
        out[sigs[1]].value = "BIGSERIAL";
        if (autoIdx !== undefined) {
          out[autoIdx].value = "";
          if (autoIdx > 0 && out[autoIdx - 1].kind === "ws") out[autoIdx - 1].value = "";
        }
      }
    }
  }

  // Handle GENERATED ALWAYS AS (round(expr, scale)) STORED
  for (let k = 0; k < out.length; k++) {
    if (wordIs(out[k], "GENERATED")) {
      const asIdx = out.findIndex((t, i) => i > k && wordIs(t, "AS"));
      if (asIdx >= 0) {
        const open = nextSig(out, asIdx + 1);
        if (open < out.length && out[open].kind === "op" && out[open].value === "(") {
          const close = findMatchingCloseParen(out, open);
          if (close > open) {
            const inner = out.slice(open + 1, close);
            const rewrittenInner = rewriteRoundForPgNumeric(inner);
            return [...out.slice(0, open + 1), ...rewrittenInner, ...out.slice(close)];
          }
        }
      }
      break;
    }
  }

  return out;
}

/**
 * Rewrite `round(expr, scale)` to `round((expr)::numeric, scale)::double precision`
 * because PostgreSQL only defines 2-arg `round(numeric, integer)`, not `round(double precision, integer)`.
 */
function rewriteRoundForPgNumeric(tokens: SqlToken[]): SqlToken[] {
  const out: SqlToken[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (wordIs(tokens[i], "ROUND")) {
      const open = nextSig(tokens, i + 1);
      if (open < tokens.length && tokens[open].kind === "op" && tokens[open].value === "(") {
        const close = findMatchingCloseParen(tokens, open);
        if (close > open && hasTopLevelComma(tokens, open, close)) {
          // Find first top-level comma
          let depth = 0;
          let commaIdx = -1;
          for (let j = open + 1; j < close; j++) {
            if (tokens[j].kind === "op") {
              if (tokens[j].value === "(") depth++;
              else if (tokens[j].value === ")") depth--;
              else if (tokens[j].value === "," && depth === 0) {
                commaIdx = j;
                break;
              }
            }
          }
          if (commaIdx > open) {
            const arg1 = joinTokens(tokens.slice(open + 1, commaIdx)).trim();
            const arg2 = joinTokens(tokens.slice(commaIdx + 1, close)).trim();
            out.push({
              kind: "word",
              value: `round((${arg1})::numeric, ${arg2})::double precision`,
            });
            i = close + 1;
            continue;
          }
        }
      }
    }
    out.push(tokens[i]);
    i++;
  }
  return out;
}

/**
 * Translate a single SQLite statement into a PostgreSQL TranslatedStatement.
 */
export function translateSingleStatement(rawSql: string): TranslatedStatement {
  const trimmed = rawSql.trim().replace(/;+\s*$/, "");
  if (!trimmed) return { sql: "", kind: "noop" };

  let tokens = tokenizeSql(trimmed);
  const sigs = sigIndices(tokens);
  if (sigs.length === 0) return { sql: "", kind: "noop" };

  const first = tokens[sigs[0]];
  const second = sigs[1] !== undefined ? tokens[sigs[1]] : undefined;
  const third = sigs[2] !== undefined ? tokens[sigs[2]] : undefined;

  // 1. PRAGMA
  if (wordIs(first, "PRAGMA")) {
    if (!second) return { sql: "", kind: "noop" };
    const pragmaName = second.value.toLowerCase();
    if (pragmaName === "table_info") {
      const openIdx = sigs[2];
      const nameIdx = sigs[3];
      if (
        openIdx !== undefined &&
        tokens[openIdx].kind === "op" &&
        tokens[openIdx].value === "(" &&
        nameIdx !== undefined
      ) {
        const tbl = unquoteIdent(tokens[nameIdx]).replaceAll("'", "''");
        return {
          sql:
            "SELECT (ordinal_position - 1)::integer AS cid, column_name::text AS name, data_type::text AS type, " +
            "CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END AS notnull, column_default::text AS dflt_value, 0 AS pk " +
            `FROM information_schema.columns WHERE table_schema = current_schema() AND lower(table_name) = lower('${tbl}') ` +
            "ORDER BY ordinal_position",
          kind: "pragma_query",
        };
      }
    }
    if (pragmaName === "quick_check") {
      return { sql: "SELECT 'ok'::text AS quick_check", kind: "pragma_query" };
    }
    if (pragmaName === "integrity_check") {
      return { sql: "SELECT 'ok'::text AS integrity_check", kind: "pragma_query" };
    }
    if (pragmaName === "journal_mode") {
      // Only treat as query if there's no '=' assignment
      const hasAssign = sigs.some((idx) => tokens[idx].kind === "op" && tokens[idx].value === "=");
      if (!hasAssign) {
        return { sql: "SELECT 'wal'::text AS journal_mode", kind: "pragma_query" };
      }
      return { sql: "", kind: "noop" };
    }
    return { sql: "", kind: "noop" };
  }

  // 2. Transaction control
  if (wordIs(first, "BEGIN")) {
    return { sql: "BEGIN", kind: "begin" };
  }
  if (wordIs(first, "COMMIT") || (wordIs(first, "END") && (!second || wordIs(second, "TRANSACTION")))) {
    return { sql: "COMMIT", kind: "commit" };
  }
  if (wordIs(first, "ROLLBACK") && !wordIs(second, "TO")) {
    return { sql: "ROLLBACK", kind: "rollback" };
  }

  // 3. CREATE TRIGGER & DROP TRIGGER (SQLite DROP TRIGGER omits `ON table`)
  if (
    wordIs(first, "CREATE") &&
    (wordIs(second, "TRIGGER") ||
      ((wordIs(second, "TEMP") || wordIs(second, "TEMPORARY")) && wordIs(third, "TRIGGER")))
  ) {
    return translateCreateTrigger(tokens);
  }
  if (wordIs(first, "DROP") && wordIs(second, "TRIGGER")) {
    const hasOn = sigs.some((idx) => wordIs(tokens[idx], "ON"));
    if (!hasOn) {
      let namePos = 2;
      if (wordIs(tokens[sigs[2]], "IF") && wordIs(tokens[sigs[3]], "EXISTS")) namePos = 4;
      const trigName = unquoteIdent(tokens[sigs[namePos]]).replaceAll("'", "''");
      return {
        sql:
          `DO $$ DECLARE tbl regclass; BEGIN ` +
          `SELECT tgrelid INTO tbl FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid ` +
          `JOIN pg_namespace n ON n.oid = c.relnamespace ` +
          `WHERE n.nspname = current_schema() AND lower(t.tgname) = lower('${trigName}') AND NOT t.tgisinternal LIMIT 1; ` +
          `IF tbl IS NOT NULL THEN EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', '${trigName}', tbl); END IF; END $$`,
        kind: "sql",
      };
    }
  }

  // 4. DDL: CREATE TABLE / ALTER TABLE
  const isCreateTable =
    wordIs(first, "CREATE") &&
    (wordIs(second, "TABLE") ||
      ((wordIs(second, "TEMP") || wordIs(second, "TEMPORARY")) && wordIs(third, "TABLE")));
  const isAlterTable = wordIs(first, "ALTER") && wordIs(second, "TABLE");
  if (isCreateTable || isAlterTable) {
    tokens = transformDdlTokens(tokens, isCreateTable);
  }

  // 5. Track INSERT metadata and handle `INSERT OR IGNORE`
  let insertTable: string | undefined;
  let appendOnConflictDoNothing = false;
  let hasReturning = false;

  const curSigs = sigIndices(tokens);
  if (wordIs(tokens[curSigs[0]], "INSERT")) {
    let intoPos = 1;
    if (wordIs(tokens[curSigs[1]], "OR") && wordIs(tokens[curSigs[2]], "IGNORE")) {
      tokens[curSigs[1]] = { kind: "ws", value: "" };
      tokens[curSigs[2]] = { kind: "ws", value: "" };
      // Also trim redundant spaces between INSERT and INTO
      if (curSigs[1] > 0 && tokens[curSigs[1] - 1].kind === "ws") tokens[curSigs[1] - 1].value = "";
      if (curSigs[2] > 0 && tokens[curSigs[2] - 1].kind === "ws") tokens[curSigs[2] - 1].value = "";
      appendOnConflictDoNothing = true;
      intoPos = 3;
    }
    if (wordIs(tokens[curSigs[intoPos]], "INTO") && curSigs[intoPos + 1] !== undefined) {
      insertTable = unquoteIdent(tokens[curSigs[intoPos + 1]]);
    }
    // Check if query already has RETURNING or ON CONFLICT at top level
    let pDepth = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.kind === "op") {
        if (t.value === "(") pDepth++;
        else if (t.value === ")") pDepth--;
      } else if (pDepth === 0 && wordIs(t, "RETURNING")) {
        hasReturning = true;
      } else if (pDepth === 0 && wordIs(t, "ON")) {
        const n1 = nextSig(tokens, i + 1);
        if (n1 < tokens.length && wordIs(tokens[n1], "CONFLICT")) {
          appendOnConflictDoNothing = false;
        }
      }
    }
  }

  // 6. General expression & identifier pass
  //    - Quote mixed-case identifiers (preserving camelCase column names & aliases like localRoom, userId)
  //    - Rewrite sqlite_master / sqlite_schema -> subquery on information_schema & pg_indexes
  //    - Rewrite scalar 2+ arg MAX(a,b) -> GREATEST(a,b) and MIN(a,b) -> LEAST(a,b)
  //    - Rewrite json_group_array(...) -> COALESCE(json_agg(...), '[]'::json)::text
  //    - Rewrite rowid (ORDER BY -> ctid, SELECT -> numeric ctid expression)
  //    - Rewrite ? -> $1, $2, ... (with $N::text when followed by IS [NOT] NULL)
  //    - Rewrite CASE WHEN $N THEN -> CASE WHEN ($N::text NOT IN ('0', 'false', '')) THEN
  let paramCount = 0;
  let inOrderBy = false;
  let orderByParenDepth = -1;
  let parenDepth = 0;

    // Pre-pass: quote mixed-case identifiers and PG-reserved column identifier `window`
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== "word") continue;
    const upper = t.value.toUpperCase();
    // Quote `window` when used as column/identifier (SQLite allows unquoted `window`, PG reserves WINDOW)
    if (upper === "WINDOW") {
      const n1 = nextSig(tokens, i + 1);
      const n2 = n1 < tokens.length ? nextSig(tokens, n1 + 1) : tokens.length;
      const isPgWindowClause =
        n1 < tokens.length && tokens[n1].kind === "word" && n2 < tokens.length && wordIs(tokens[n2], "AS");
      if (!isPgWindowClause) {
        t.value = `"${t.value}"`;
        t.kind = "dquote";
      }
      continue;
    }
    if (SQL_KEYWORDS.has(upper)) continue;
    if (!isMixedCaseIdent(t.value)) continue;
    const n1 = nextSig(tokens, i + 1);
    // Do not quote function calls like `fooBar(...)`
    if (n1 < tokens.length && tokens[n1].kind === "op" && tokens[n1].value === "(") continue;
    t.value = `"${t.value}"`;
    t.kind = "dquote";
  }

  // Pass for placeholders `?`, sqlite_master, MAX/MIN(a,b), rowid
  const step1: SqlToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "op") {
      if (t.value === "(") parenDepth++;
      else if (t.value === ")") {
        if (inOrderBy && parenDepth === orderByParenDepth) {
          inOrderBy = false;
          orderByParenDepth = -1;
        }
        if (parenDepth > 0) parenDepth--;
      }
      step1.push(t);
      continue;
    }

    if (t.kind === "word") {
      const upper = t.value.toUpperCase();
      if (upper === "ORDER") {
        const n1 = nextSig(tokens, i + 1);
        if (n1 < tokens.length && wordIs(tokens[n1], "BY")) {
          inOrderBy = true;
          orderByParenDepth = parenDepth;
        }
      } else if (
        inOrderBy &&
        parenDepth === orderByParenDepth &&
        (upper === "LIMIT" || upper === "OFFSET" || upper === "UNION" || upper === "EXCEPT" || upper === "INTERSECT")
      ) {
        inOrderBy = false;
        orderByParenDepth = -1;
      }

      // SQLite `expr IS NOT <val>` / `(a,b) IS NOT (c,d)` -> PG `IS DISTINCT FROM`
      // SQLite `expr IS <val>` / `(a,b) IS (c,d)` -> PG `IS NOT DISTINCT FROM`
      if (upper === "IS") {
        const n1 = nextSig(tokens, i + 1);
        if (n1 < tokens.length) {
          if (wordIs(tokens[n1], "NOT")) {
            const n2 = nextSig(tokens, n1 + 1);
            if (n2 < tokens.length) {
              const targetTok = tokens[n2];
              const isStandardPgIsNot =
                targetTok.kind === "word" &&
                ["NULL", "TRUE", "FALSE", "UNKNOWN", "DISTINCT", "OF", "NORMALIZED"].includes(
                  targetTok.value.toUpperCase(),
                );
              if (!isStandardPgIsNot) {
                step1.push({ kind: "word", value: "IS DISTINCT FROM" });
                i = n1;
                continue;
              }
            }
          } else {
            const targetTok = tokens[n1];
            const isStandardPgIs =
              targetTok.kind === "word" &&
              ["NULL", "TRUE", "FALSE", "UNKNOWN", "DISTINCT", "OF", "NORMALIZED"].includes(
                targetTok.value.toUpperCase(),
              );
            if (!isStandardPgIs) {
              step1.push({ kind: "word", value: "IS NOT DISTINCT FROM" });
              continue;
            }
          }
        }
      }

      // sqlite_master / sqlite_schema after FROM or JOIN
      if (upper === "SQLITE_MASTER" || upper === "SQLITE_SCHEMA") {
        const p1 = prevSig(tokens, i - 1);
        if (p1 >= 0 && (wordIs(tokens[p1], "FROM") || wordIs(tokens[p1], "JOIN"))) {
          step1.push({ kind: "word", value: SQLITE_MASTER_SUBQUERY });
          continue;
        }
      }

      // 2+ arg MAX(a, b) -> GREATEST(a, b), MIN(a, b) -> LEAST(a, b)
      if (upper === "MAX" || upper === "MIN") {
        const open = nextSig(tokens, i + 1);
        if (open < tokens.length && tokens[open].kind === "op" && tokens[open].value === "(") {
          const close = findMatchingCloseParen(tokens, open);
          if (close > open && hasTopLevelComma(tokens, open, close)) {
            step1.push({ kind: "word", value: upper === "MAX" ? "GREATEST" : "LEAST" });
            continue;
          }
        }
      }

      // rowid
      if (upper === "ROWID") {
        if (inOrderBy) {
          step1.push({ kind: "word", value: "ctid" });
          continue;
        }
        // Check if preceded by alias dot (e.g. `b.rowid`)
        const pDot = prevSig(step1, step1.length - 1);
        if (pDot >= 0 && step1[pDot].kind === "op" && step1[pDot].value === ".") {
          const pAlias = prevSig(step1, pDot - 1);
          if (pAlias >= 0 && (step1[pAlias].kind === "word" || step1[pAlias].kind === "dquote")) {
            const alias = step1[pAlias].value;
            step1.splice(pAlias, step1.length - pAlias, {
              kind: "word",
              value: `(((${alias}.ctid::text::point)[0]::bigint * 65536 + (${alias}.ctid::text::point)[1]::bigint)) AS rowid`,
            });
            continue;
          }
        }
        step1.push({
          kind: "word",
          value: "(((ctid::text::point)[0]::bigint * 65536 + (ctid::text::point)[1]::bigint)) AS rowid",
        });
        continue;
      }
    }

    if (t.kind === "qmark") {
      paramCount++;
      const n1 = nextSig(tokens, i + 1);
      const n2 = n1 < tokens.length ? nextSig(tokens, n1 + 1) : tokens.length;
      const n3 = n2 < tokens.length ? nextSig(tokens, n2 + 1) : tokens.length;
      const followedByIsNull =
        wordIs(tokens[n1], "IS") &&
        (wordIs(tokens[n2], "NULL") || (wordIs(tokens[n2], "NOT") && wordIs(tokens[n3], "NULL")));

      // Check `CASE WHEN ? THEN`
      const p1 = prevSig(tokens, i - 1);
      const isCaseWhenParam = wordIs(tokens[p1], "WHEN") && wordIs(tokens[n1], "THEN");

      if (followedByIsNull) {
        step1.push({ kind: "word", value: `$${paramCount}::text` });
      } else if (isCaseWhenParam) {
        step1.push({ kind: "word", value: `($${paramCount}::text NOT IN ('0', 'false', ''))` });
      } else {
        step1.push({ kind: "word", value: `$${paramCount}` });
      }
      continue;
    }

    step1.push(t);
  }

  // Pass 7: Rewrite `json_group_array(...)` -> `COALESCE(json_agg(...), '[]'::json)::text`
  const step2: SqlToken[] = [];
  for (let i = 0; i < step1.length; i++) {
    if (wordIs(step1[i], "JSON_GROUP_ARRAY")) {
      const open = nextSig(step1, i + 1);
      if (open < step1.length && step1[open].kind === "op" && step1[open].value === "(") {
        const close = findMatchingCloseParen(step1, open);
        if (close > open) {
          const inner = joinTokens(step1.slice(open + 1, close));
          step2.push({ kind: "word", value: `COALESCE(json_agg(${inner}), '[]'::json)::text` });
          i = close;
          continue;
        }
      }
    }
    step2.push(step1[i]);
  }

  // Pass 8: Rewrite DML `COLLATE NOCASE` and `GLOB`
  const step3 = rewriteCollateNocaseAndGlob(step2);

  let finalSql = joinTokens(step3).trim();

  if (appendOnConflictDoNothing) {
    if (hasReturning) {
      // Insert ON CONFLICT DO NOTHING right before top-level RETURNING
      const fTokens = tokenizeSql(finalSql);
      let d = 0;
      let retIdx = -1;
      for (let i = 0; i < fTokens.length; i++) {
        if (fTokens[i].kind === "op") {
          if (fTokens[i].value === "(") d++;
          else if (fTokens[i].value === ")") d--;
        } else if (d === 0 && wordIs(fTokens[i], "RETURNING")) {
          retIdx = i;
          break;
        }
      }
      if (retIdx > 0) {
        finalSql =
          joinTokens(fTokens.slice(0, retIdx)).trimEnd() +
          " ON CONFLICT DO NOTHING " +
          joinTokens(fTokens.slice(retIdx)).trimStart();
      } else {
        finalSql += " ON CONFLICT DO NOTHING";
      }
    } else {
      finalSql += " ON CONFLICT DO NOTHING";
    }
  }

  return {
    sql: finalSql,
    kind: "sql",
    insertTable,
    hasReturning,
  };
}

function rewriteCollateNocaseAndGlob(inputTokens: SqlToken[]): SqlToken[] {
  let tokens = [...inputTokens];

  // Rewrite `lhs GLOB rhs` -> `public.sqlite_glob((lhs)::text, (rhs)::text)`
  for (let i = 0; i < tokens.length; i++) {
    if (!wordIs(tokens[i], "GLOB")) continue;
    const lhsEnd = prevSig(tokens, i - 1);
    const rhsStart = nextSig(tokens, i + 1);
    if (lhsEnd < 0 || rhsStart >= tokens.length) continue;

    // Check optional `NOT GLOB`
    let lhsStart = findExprStartBackward(tokens, lhsEnd);
    let negated = false;
    const maybeNot = prevSig(tokens, lhsEnd);
    if (wordIs(tokens[maybeNot], "NOT")) {
      negated = true;
      const realLhsEnd = prevSig(tokens, maybeNot - 1);
      lhsStart = findExprStartBackward(tokens, realLhsEnd);
      const lhsExpr = joinTokens(tokens.slice(lhsStart, realLhsEnd + 1)).trim();
      const rhsEnd = findExprEndForward(tokens, rhsStart);
      const rhsExpr = joinTokens(tokens.slice(rhsStart, rhsEnd + 1)).trim();
      const replacement: SqlToken = {
        kind: "word",
        value: `NOT public.sqlite_glob((${lhsExpr})::text, (${rhsExpr})::text)`,
      };
      tokens = [...tokens.slice(0, lhsStart), replacement, ...tokens.slice(rhsEnd + 1)];
      i = lhsStart;
      continue;
    }

    const lhsExpr = joinTokens(tokens.slice(lhsStart, lhsEnd + 1)).trim();
    const rhsEnd = findExprEndForward(tokens, rhsStart);
    const rhsExpr = joinTokens(tokens.slice(rhsStart, rhsEnd + 1)).trim();
    const replacement: SqlToken = {
      kind: "word",
      value: `${negated ? "NOT " : ""}public.sqlite_glob((${lhsExpr})::text, (${rhsExpr})::text)`,
    };
    tokens = [...tokens.slice(0, lhsStart), replacement, ...tokens.slice(rhsEnd + 1)];
    i = lhsStart;
  }

  // Rewrite DML `COLLATE NOCASE`
  for (let i = 0; i < tokens.length; i++) {
    if (!wordIs(tokens[i], "COLLATE")) continue;
    const n1 = nextSig(tokens, i + 1);
    if (n1 >= tokens.length || !wordIs(tokens[n1], "NOCASE")) continue;

    const rhsEnd = prevSig(tokens, i - 1);
    if (rhsEnd < 0) continue;
    const rhsStart = findExprStartBackward(tokens, rhsEnd);
    const beforeRhs = prevSig(tokens, rhsStart - 1);

    if (
      beforeRhs >= 0 &&
      tokens[beforeRhs].kind === "op" &&
      (tokens[beforeRhs].value === "=" || tokens[beforeRhs].value === "<>" || tokens[beforeRhs].value === "!=")
    ) {
      const op = tokens[beforeRhs].value;
      const lhsEnd = prevSig(tokens, beforeRhs - 1);
      if (lhsEnd >= 0) {
        const lhsStart = findExprStartBackward(tokens, lhsEnd);
        const lhsExpr = joinTokens(tokens.slice(lhsStart, lhsEnd + 1)).trim();
        const rhsExpr = joinTokens(tokens.slice(rhsStart, rhsEnd + 1)).trim();
        const replacement: SqlToken = {
          kind: "word",
          value: `((${lhsExpr})::citext ${op} (${rhsExpr})::citext)`,
        };
        tokens = [...tokens.slice(0, lhsStart), replacement, ...tokens.slice(n1 + 1)];
        i = lhsStart;
        continue;
      }
    }

    // Fallback (e.g., ORDER BY col COLLATE NOCASE)
    const expr = joinTokens(tokens.slice(rhsStart, rhsEnd + 1)).trim();
    const replacement: SqlToken = {
      kind: "word",
      value: `(${expr})::citext`,
    };
    tokens = [...tokens.slice(0, rhsStart), replacement, ...tokens.slice(n1 + 1)];
    i = rhsStart;
  }

  return tokens;
}

/**
 * Translate a possibly multi-statement SQLite SQL string into an ordered array
 * of PostgreSQL statements.
 */
export function translateSqliteToPgStatements(sql: string): TranslatedStatement[] {
  const parts = splitSqlStatements(sql);
  const results: TranslatedStatement[] = [];
  for (const part of parts) {
    const tr = translateSingleStatement(part);
    if (tr.kind === "noop" || !tr.sql) continue;
    results.push({
      sql: tr.sql,
      kind: tr.kind,
      insertTable: tr.insertTable,
      hasReturning: tr.hasReturning,
    });
    if (tr.extraSqls) {
      for (const extra of tr.extraSqls) {
        results.push({ sql: extra, kind: "sql" });
      }
    }
  }
  return results;
}

export interface DeferredForeignKey {
  table: string;
  refTable: string;
  constraintSql: string;
}

/**
 * Strip `REFERENCES <missingTable>(...)` clauses from a translated PostgreSQL
 * `CREATE TABLE` statement so forward-referenced SQLite DDL succeeds even when
 * tables are created out of topological order. Returns the stripped DDL and
 * deferred `ALTER TABLE` foreign key definitions.
 */
export function stripMissingForeignKeys(
  createTableSql: string,
  existingTables: Set<string>,
): { sql: string; deferred: DeferredForeignKey[] } {
  const tokens = tokenizeSql(createTableSql);
  const sigs = sigIndices(tokens);
  if (!wordIs(tokens[sigs[0]], "CREATE")) return { sql: createTableSql, deferred: [] };

  const openParen = tokens.findIndex((t) => t.kind === "op" && t.value === "(");
  if (openParen < 0) return { sql: createTableSql, deferred: [] };
  const closeParen = findMatchingCloseParen(tokens, openParen);
  if (closeParen <= openParen) return { sql: createTableSql, deferred: [] };

  // Extract table name right before `(`
  const tableTokIdx = prevSig(tokens, openParen - 1);
  if (tableTokIdx < 0) return { sql: createTableSql, deferred: [] };
  const tableName = unquoteIdent(tokens[tableTokIdx]);
  const tableLower = tableName.toLowerCase();

  // Split table body by top-level commas
  const body = tokens.slice(openParen + 1, closeParen);
  const parts: SqlToken[][] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const t = body[i];
    if (t.kind === "op") {
      if (t.value === "(") depth++;
      else if (t.value === ")") depth--;
      else if (t.value === "," && depth === 0) {
        parts.push(body.slice(start, i));
        start = i + 1;
      }
    }
  }
  parts.push(body.slice(start));

  const deferred: DeferredForeignKey[] = [];
  const keptParts: string[] = [];

  for (const part of parts) {
    const pSigs = sigIndices(part);
    if (pSigs.length === 0) continue;

    // Table-level FOREIGN KEY (...) REFERENCES refTable(...)
    const isTableFk =
      (wordIs(part[pSigs[0]], "FOREIGN") && wordIs(part[pSigs[1]], "KEY")) ||
      (wordIs(part[pSigs[0]], "CONSTRAINT") && wordIs(part[pSigs[2]], "FOREIGN"));
    if (isTableFk) {
      const refIdx = part.findIndex((t) => wordIs(t, "REFERENCES"));
      if (refIdx >= 0) {
        const refTblIdx = nextSig(part, refIdx + 1);
        if (refTblIdx < part.length) {
          const refTable = unquoteIdent(part[refTblIdx]);
          if (refTable.toLowerCase() !== tableLower && !existingTables.has(refTable.toLowerCase())) {
            deferred.push({
              table: tableName,
              refTable,
              constraintSql: joinTokens(part).trim(),
            });
            continue;
          }
        }
      }
      keptParts.push(joinTokens(part).trim());
      continue;
    }

    // Inline column-level REFERENCES refTable(...) [ON DELETE ...] [ON UPDATE ...]
    const colName = part[pSigs[0]].value;
    let outPart = [...part];
    let idx = 0;
    while (idx < outPart.length) {
      if (!wordIs(outPart[idx], "REFERENCES")) {
        idx++;
        continue;
      }
      const refTblIdx = nextSig(outPart, idx + 1);
      if (refTblIdx >= outPart.length) break;
      const refTable = unquoteIdent(outPart[refTblIdx]);
      // Find end of REFERENCES clause: optional (cols), optional ON DELETE/UPDATE actions
      let endIdx = refTblIdx;
      const maybeOpen = nextSig(outPart, endIdx + 1);
      if (maybeOpen < outPart.length && outPart[maybeOpen].kind === "op" && outPart[maybeOpen].value === "(") {
        const close = findMatchingCloseParen(outPart, maybeOpen);
        if (close > maybeOpen) endIdx = close;
      }
      while (true) {
        const n1 = nextSig(outPart, endIdx + 1);
        const n2 = n1 < outPart.length ? nextSig(outPart, n1 + 1) : outPart.length;
        if (wordIs(outPart[n1], "ON") && (wordIs(outPart[n2], "DELETE") || wordIs(outPart[n2], "UPDATE"))) {
          const n3 = nextSig(outPart, n2 + 1);
          if (wordIs(outPart[n3], "SET") || wordIs(outPart[n3], "NO")) {
            const n4 = nextSig(outPart, n3 + 1);
            endIdx = n4 < outPart.length ? n4 : n3;
          } else {
            endIdx = n3 < outPart.length ? n3 : n2;
          }
          continue;
        }
        break;
      }

      if (refTable.toLowerCase() !== tableLower && !existingTables.has(refTable.toLowerCase())) {
        const refClause = joinTokens(outPart.slice(idx, endIdx + 1)).trim();
        deferred.push({
          table: tableName,
          refTable,
          constraintSql: `FOREIGN KEY (${colName}) ${refClause}`,
        });
        outPart = [...outPart.slice(0, idx), ...outPart.slice(endIdx + 1)];
        continue;
      }
      idx = endIdx + 1;
    }

    keptParts.push(joinTokens(outPart).trim());
  }

  if (deferred.length === 0) {
    return { sql: createTableSql, deferred: [] };
  }

  const prefix = joinTokens(tokens.slice(0, openParen + 1));
  const suffix = joinTokens(tokens.slice(closeParen));
  return {
    sql: `${prefix}\n  ${keptParts.join(",\n  ")}\n${suffix}`,
    deferred,
  };
}

/**
 * Convenience function translating a single SQLite statement into a PostgreSQL string.
 */
export function translateSqliteToPg(sql: string): string {
  const stmts = translateSqliteToPgStatements(sql);
  return stmts.map((s) => s.sql).join(";\n");
}
