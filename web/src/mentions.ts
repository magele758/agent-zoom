export type MentionQuery = { start: number; query: string };

const ACTIVE = /@([a-zA-Z0-9-]{0,31})$/;
const HANDLE = /@([a-zA-Z][a-zA-Z0-9-]{0,31})/g;

/** The @ token the caret is inside, if @ starts a word. */
export function mentionAtCaret(body: string, caret: number): MentionQuery | null {
  const before = body.slice(0, Math.max(0, caret));
  const match = before.match(ACTIVE);
  if (!match || match.index === undefined) return null;
  if (match.index > 0 && !/\s/.test(before[match.index - 1])) return null;
  return { start: match.index, query: match[1].toLowerCase() };
}

/** Handles the server would wake, except the token still being typed. */
export function settledMentions(body: string, caret: number): string[] {
  const active = mentionAtCaret(body, caret);
  const found: string[] = [];
  for (const match of body.matchAll(HANDLE)) {
    const start = match.index ?? 0;
    if (active && start === active.start) continue;
    const handle = match[1].toLowerCase();
    if (handle && !found.includes(handle)) found.push(handle);
  }
  return found;
}

export function splitMentions(body: string): Array<{ text: string; handle: string | null }> {
  const parts: Array<{ text: string; handle: string | null }> = [];
  let last = 0;
  for (const match of body.matchAll(HANDLE)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: body.slice(last, start), handle: null });
    parts.push({ text: match[0], handle: match[1].toLowerCase() });
    last = start + match[0].length;
  }
  if (last < body.length || parts.length === 0) parts.push({ text: body.slice(last), handle: null });
  return parts;
}
