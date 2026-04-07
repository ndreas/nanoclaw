const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

const threshold =
  LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{\n      "type": "${err.constructor.name}",\n      "message": "${err.message}",\n      "stack":\n          ${err.stack}\n    }`;
  }
  return JSON.stringify(err);
}

function formatData(data: Record<string, unknown>): string {
  let out = '';
  for (const [k, v] of Object.entries(data)) {
    if (k === 'err') {
      out += `\n    ${KEY_COLOR}err${RESET}: ${formatErr(v)}`;
    } else {
      out += `\n    ${KEY_COLOR}${k}${RESET}: ${JSON.stringify(v)}`;
    }
  }
  return out;
}

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function log(
  level: Level,
  dataOrMsg: Record<string, unknown> | string,
  msg?: string,
): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  if (typeof dataOrMsg === 'string') {
    stream.write(
      `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${dataOrMsg}${RESET}\n`,
    );
  } else {
    stream.write(
      `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${msg}${RESET}${formatData(dataOrMsg)}\n`,
    );
  }
}

type Logger = {
  debug: (dataOrMsg: Record<string, unknown> | string, msg?: string) => void;
  info: (dataOrMsg: Record<string, unknown> | string, msg?: string) => void;
  warn: (dataOrMsg: Record<string, unknown> | string, msg?: string) => void;
  error: (dataOrMsg: Record<string, unknown> | string, msg?: string) => void;
  fatal: (dataOrMsg: Record<string, unknown> | string, msg?: string) => void;
  child: (bindings: Record<string, unknown>) => Logger;
};

function makeLogger(bindings: Record<string, unknown> = {}): Logger {
  function logWithBindings(
    level: Level,
    dataOrMsg: Record<string, unknown> | string,
    msg?: string,
  ): void {
    if (typeof dataOrMsg === 'string') {
      log(
        level,
        Object.keys(bindings).length ? { ...bindings } : dataOrMsg,
        typeof dataOrMsg === 'string' && Object.keys(bindings).length
          ? dataOrMsg
          : msg,
      );
    } else {
      log(level, { ...bindings, ...dataOrMsg }, msg);
    }
  }
  return {
    debug: (dataOrMsg, msg) => logWithBindings('debug', dataOrMsg, msg),
    info: (dataOrMsg, msg) => logWithBindings('info', dataOrMsg, msg),
    warn: (dataOrMsg, msg) => logWithBindings('warn', dataOrMsg, msg),
    error: (dataOrMsg, msg) => logWithBindings('error', dataOrMsg, msg),
    fatal: (dataOrMsg, msg) => logWithBindings('fatal', dataOrMsg, msg),
    child: (childBindings) => makeLogger({ ...bindings, ...childBindings }),
  };
}

export const logger: Logger = makeLogger();

// Route uncaught errors through logger so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
