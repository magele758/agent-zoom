import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context, Hono } from "hono";
import { ApiError } from "./logic.ts";

const execFileAsync = promisify(execFile);

const HERDR_ADDRESS_RE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DISALLOWED_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const MAX_MESSAGE_LEN = 4000;

const SECRET_PATTERNS = [
  /(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abpr]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /(api[_-]?key|token|secret|password|passwd|bearer)\s*[:=]\s*\S+/gi,
];

export function redactScreenLine(line: string): string {
  let out = line;
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

export function validateHerdrAddress(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ApiError(400, "invalid_herdr_address", "缺少有效的 Herdr 终端地址。");
  }
  const address = raw.trim();
  if (!address || !HERDR_ADDRESS_RE.test(address)) {
    throw new ApiError(400, "invalid_herdr_address", "Herdr 终端地址格式无效。");
  }
  return address;
}

export type HerdrExecFn = (
  file: string,
  args: string[],
  options?: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface HerdrControlOptions {
  hcBin?: string;
  herdrAppBin?: string;
  execFn?: HerdrExecFn;
}

export interface HerdrFocusResult {
  ok: true;
  address: string;
  command: "agent.focus" | "pane.focus";
}

export interface HerdrSendResult {
  ok: true;
  address: string;
  sentAt: string;
  previousStatus: string | null;
}

export interface HerdrScreenResult {
  ok: true;
  address: string;
  lines: string[];
  truncated: boolean;
}

export class HerdrController {
  private readonly hcBin: string;
  private readonly herdrAppBin: string;
  private readonly execFn: HerdrExecFn;

  constructor(options: HerdrControlOptions = {}) {
    this.hcBin = options.hcBin ?? process.env.HC_BIN ?? "hc";
    this.herdrAppBin = options.herdrAppBin ?? process.env.HERDR_APP_BIN ?? "herdr-app";
    this.execFn =
      options.execFn ??
      ((file, args, opts) =>
        execFileAsync(file, args, {
          timeout: opts?.timeout ?? 4000,
          maxBuffer: opts?.maxBuffer ?? 1024 * 1024,
        }));
  }

  async focusTerminal(rawAddress: string): Promise<HerdrFocusResult> {
    const address = validateHerdrAddress(rawAddress);
    try {
      await this.execFn(this.herdrAppBin, ["do", "agent.focus", "--terminal", address], {
        timeout: 4000,
      });
      return { ok: true, address, command: "agent.focus" };
    } catch {
      try {
        await this.execFn(this.herdrAppBin, ["do", "pane.focus", "--terminal", address], {
          timeout: 4000,
        });
        return { ok: true, address, command: "pane.focus" };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ApiError(
          502,
          "herdr_focus_failed",
          `无法切换到 Herdr 终端 ${address}，请确认 Herdr 桌面端正在运行。${msg.includes("ENOENT") ? "（未找到 herdr-app）" : ""}`,
        );
      }
    }
  }

  async inspectTerminal(rawAddress: string): Promise<{ state: string | null; status: string | null; title: string | null }> {
    const address = validateHerdrAddress(rawAddress);
    try {
      const { stdout } = await this.execFn(this.hcBin, ["get", "--json", address], {
        timeout: 3000,
        maxBuffer: 1024 * 1024,
      });
      const parsed = JSON.parse(stdout) as { state?: unknown; status?: unknown; title?: unknown };
      return {
        state: typeof parsed.state === "string" ? parsed.state : null,
        status: typeof parsed.status === "string" ? parsed.status : null,
        title: typeof parsed.title === "string" ? parsed.title : null,
      };
    } catch {
      throw new ApiError(404, "terminal_not_found", `未找到 Herdr 终端 ${address} 或当前不可达。`);
    }
  }

  async sendInstruction(rawAddress: string, rawMessage: unknown): Promise<HerdrSendResult> {
    const address = validateHerdrAddress(rawAddress);
    if (typeof rawMessage !== "string") {
      throw new ApiError(400, "invalid_message", "指令内容不能为空。");
    }
    const message = rawMessage.trim();
    if (!message || message.length > MAX_MESSAGE_LEN) {
      throw new ApiError(400, "invalid_message", `指令长度需在 1 到 ${MAX_MESSAGE_LEN} 个字符之间。`);
    }
    if (DISALLOWED_CONTROL_RE.test(message)) {
      throw new ApiError(400, "invalid_message", "指令包含不允许的控制字符。");
    }

    const info = await this.inspectTerminal(address);
    if (info.state && info.state !== "live") {
      throw new ApiError(409, "terminal_not_live", `终端 ${address} 当前状态为 ${info.state}，已结束或不可交互。`);
    }
    if (info.status === "blocked") {
      throw new ApiError(
        409,
        "terminal_blocked",
        `终端 ${address} 当前处于权限/交互阻塞态（blocked），为保障安全禁止远程代答；请点击「切到 Herdr」亲自确认。`,
      );
    }

    try {
      // Strictly never pass `--force`: hc itself also refuses blocked dialogs as a second safety layer.
      await this.execFn(this.hcBin, ["send", address, message], {
        timeout: 5000,
      });
      return {
        ok: true,
        address,
        sentAt: new Date().toISOString(),
        previousStatus: info.status,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (/blocked|dialog|force/i.test(detail)) {
        throw new ApiError(
          409,
          "terminal_blocked",
          `终端 ${address} 正在等待安全确认，请点击「切到 Herdr」在现场亲自处理。`,
        );
      }
      throw new ApiError(502, "herdr_send_failed", `向 Herdr 终端 ${address} 发送指令失败。`);
    }
  }

  async readScreenTail(rawAddress: string, maxLines = 24): Promise<HerdrScreenResult> {
    const address = validateHerdrAddress(rawAddress);
    const limit = Math.max(5, Math.min(80, Math.floor(Number(maxLines) || 24)));
    try {
      const { stdout } = await this.execFn(this.hcBin, ["screen", address], {
        timeout: 3000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const allLines = stdout
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => redactScreenLine(line.trimEnd()));
      while (allLines.length > 0 && allLines[allLines.length - 1].trim() === "") {
        allLines.pop();
      }
      const truncated = allLines.length > limit;
      const lines = truncated ? allLines.slice(-limit) : allLines;
      return { ok: true, address, lines, truncated };
    } catch {
      throw new ApiError(502, "herdr_screen_failed", `无法读取 Herdr 终端 ${address} 的屏幕内容。`);
    }
  }
}

export function registerHerdrControlRoutes(
  app: Hono,
  requireUser: (c: Context) => unknown,
  options: HerdrControlOptions = {},
): HerdrController {
  const controller = new HerdrController(options);
  const base = "/api/opc/herdr";

  // Strictly require human operator session (never agent tokens) for interactive desktop/terminal control.
  app.use(`${base}/*`, async (c, next) => {
    requireUser(c);
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.post(`${base}/focus`, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { address?: unknown };
    return c.json(await controller.focusTerminal(String(body.address ?? "")));
  });

  app.post(`${base}/:address/focus`, async (c) => {
    return c.json(await controller.focusTerminal(c.req.param("address")));
  });

  app.post(`${base}/send`, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { address?: unknown; message?: unknown };
    return c.json(await controller.sendInstruction(String(body.address ?? ""), body.message));
  });

  app.post(`${base}/:address/send`, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { message?: unknown };
    return c.json(await controller.sendInstruction(c.req.param("address"), body.message));
  });

  app.get(`${base}/screen`, async (c) => {
    const address = c.req.query("address") ?? "";
    const lines = Number(c.req.query("lines") ?? "24");
    return c.json(await controller.readScreenTail(address, lines));
  });

  return controller;
}
