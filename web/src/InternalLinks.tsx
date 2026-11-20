import { Fragment } from "react";

const internalLinkPattern =
  /(#ideas\?idea=[a-f0-9-]{36}|#home-room\?binding=[a-f0-9-]{36}(?:&post=[a-f0-9-]{36})?)/gi;

export function extractIdeaId(text: string): string | null {
  const match = /#ideas\?idea=([a-f0-9-]{36})/i.exec(text);
  return match ? match[1] : null;
}

export function LinkedText({ text }: { text: string }) {
  const parts = text.split(internalLinkPattern);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) => {
        if (/^#ideas\?idea=[a-f0-9-]{36}$/i.test(part)) {
          return (
            <a key={index} href={part}>
              查看来源想法 ↗
            </a>
          );
        }
        if (/^#home-room\?binding=[a-f0-9-]{36}(?:&post=[a-f0-9-]{36})?$/i.test(part)) {
          return (
            <a key={index} href={part}>
              打开原讨论 ↗
            </a>
          );
        }
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}
