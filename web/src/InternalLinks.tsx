import { Fragment } from "react";

const internalLinkPattern =
  /(#ideas\?idea=[a-f0-9-]{36}|#home-room\?(?:binding=[a-f0-9-]{36}(?:&post=[a-f0-9-]{36})?|room=[a-zA-Z0-9._-]+)|#workflows\/[a-f0-9-]{36}|#business-lines\?[a-zA-Z0-9=&_%.-]+|#capabilities\?[a-zA-Z0-9=&_%.-]+|#stage\?[a-zA-Z0-9=&_%.-]+)/gi;

export function extractIdeaId(text: string): string | null {
  const match = /#ideas\?idea=([a-f0-9-]{36})/i.exec(text);
  return match ? match[1] : null;
}

function linkLabel(part: string): string | null {
  if (/^#ideas\?idea=[a-f0-9-]{36}$/i.test(part)) return "查看来源想法 ↗";
  if (/^#home-room\?(?:binding=[a-f0-9-]{36}(?:&post=[a-f0-9-]{36})?|room=[a-zA-Z0-9._-]+)$/i.test(part)) return "打开原讨论 ↗";
  if (/^#workflows\/[a-f0-9-]{36}$/i.test(part)) return "打开工作流审批 ↗";
  if (/^#business-lines\?[a-zA-Z0-9=&_%.-]+$/i.test(part)) return "打开经营实验 ↗";
  if (/^#capabilities\?[a-zA-Z0-9=&_%.-]+$/i.test(part)) return "打开开源能力 ↗";
  if (/^#stage\?[a-zA-Z0-9=&_%.-]+$/i.test(part)) return "打开阶段工作单 ↗";
  return null;
}

export function LinkedText({ text }: { text: string }) {
  const parts = text.split(internalLinkPattern);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) => {
        const label = linkLabel(part);
        if (label) {
          return (
            <a key={index} href={part}>
              {label}
            </a>
          );
        }
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}
