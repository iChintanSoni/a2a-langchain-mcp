import { inspect } from "node:util";

type LogLevel = "debug" | "info" | "success" | "warn" | "error" | "event";

type LoggerMethod = (message: string, data?: unknown) => void;

export type Logger = {
  debug: LoggerMethod;
  info: LoggerMethod;
  success: LoggerMethod;
  warn: LoggerMethod;
  error: LoggerMethod;
  event: LoggerMethod;
  child: (scope: string) => Logger;
};

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const COLORS = {
  gray: "\u001b[90m",
  blue: "\u001b[94m",
  cyan: "\u001b[96m",
  green: "\u001b[92m",
  yellow: "\u001b[93m",
  red: "\u001b[91m",
  magenta: "\u001b[95m",
} as const;

const USE_COLORS = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function color(text: string, code: string): string {
  if (!USE_COLORS) return text;
  return `${code}${text}${RESET}`;
}

function formatData(data: unknown): string {
  if (data === undefined) return "";

  if (data instanceof Error) {
    return `\n${data.stack ?? data.message}`;
  }

  if (typeof data === "string") {
    return ` ${data}`;
  }

  return ` ${inspect(data, {
    depth: 6,
    colors: USE_COLORS,
    compact: false,
    breakLength: 100,
  })}`;
}

function logLine(scope: string, level: LogLevel, message: string, data?: unknown): void {
  const timestamp = color(new Date().toISOString(), COLORS.gray);
  const scopeLabel = color(`[${scope}]`, BOLD);

  const levelColor: Record<LogLevel, string> = {
    debug: COLORS.blue,
    info: COLORS.cyan,
    success: COLORS.green,
    warn: COLORS.yellow,
    error: COLORS.red,
    event: COLORS.magenta,
  };

  const levelLabel = color(`[${level.toUpperCase()}]`, levelColor[level]);
  const line = `${timestamp} ${scopeLabel} ${levelLabel} ${message}${formatData(data)}`;

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

export function createLogger(scope: string): Logger {
  const child = (name: string) => createLogger(`${scope}/${name}`);

  return {
    debug: (message, data) => logLine(scope, "debug", message, data),
    info: (message, data) => logLine(scope, "info", message, data),
    success: (message, data) => logLine(scope, "success", message, data),
    warn: (message, data) => logLine(scope, "warn", message, data),
    error: (message, data) => logLine(scope, "error", message, data),
    event: (message, data) => logLine(scope, "event", message, data),
    child,
  };
}

export const logger = createLogger("app");
