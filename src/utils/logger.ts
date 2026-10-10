import dns from 'dns';

import util from 'util';
import 'winston-mongodb';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import { createLogger, format, transports } from 'winston';
import type { MongoDBTransportInstance } from 'winston-mongodb';
import config from '../config/config.js';
import path from 'path';
import { red, blue, yellow, green, magenta } from 'colorette';
import * as sourceMapSupport from 'source-map-support';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Enable source map support for stack traces
sourceMapSupport.install();

// Only override Node's DNS resolver in safe scenarios:
// - Explicitly enabled via `FORCE_NODE_DNS_SERVERS=true`, OR
// - Running on Windows in local development (`config.ENV === 'development'`)
// Never force in Vercel/production environments.
try {
  const shouldForce = process.env.FORCE_NODE_DNS_SERVERS === 'true' || (process.platform === 'win32' && config.ENV === 'development')
  if (!process.env.VERCEL && shouldForce) {
    dns.setServers(['8.8.8.8', '1.1.1.1'])
  }
} catch {
  // Keep the default resolver if the servers can't be set.
}

// --------------------
// Helper to color log levels
// --------------------
const colorizeLevel = (level: string) => {
  switch (level.toUpperCase()) {
    case 'ERROR':
      return red(level);
    case 'INFO':
      return blue(level);
    case 'WARN':
      return yellow(level);
    default:
      return level;
  }
};

// --------------------
// Console log format
// --------------------
const consoleLogFormat = format.printf((info) => {
    const { level, message, timestamp } = info as { level: string; message: string; timestamp: string };
    const meta = { ...info, level: undefined, message: undefined, timestamp: undefined };

    const customLevel = colorizeLevel(level.toUpperCase());
    const customTimestamp = green(timestamp); // now typed as string

    const customMeta = util.inspect(meta, { showHidden: false, depth: null, colors: true });

    return `${customLevel} [${customTimestamp}] ${message}\n${magenta('META')} ${customMeta}\n`;
});


const consoleTransport = () => {
  return [
    new transports.Console({
      level: 'info',
      format: format.combine(format.timestamp(), consoleLogFormat),
    }),
  ];
};

// --------------------
// File log format
// --------------------
const fileLogFormat = format.printf(({ level, message, timestamp, ...meta }) => {
  const logMeta: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(meta)) {
    if (value instanceof Error) {
      logMeta[key] = {
        name: value.name,
        message: value.message,
        trace: value.stack || '',
      };
    } else {
      logMeta[key] = value;
    }
  }

  return JSON.stringify(
    {
      level: level.toUpperCase(),
      message,
      timestamp,
      meta: logMeta,
    },
    null,
    4
  );
});

const fileTransport = () => {
  // Vercel has a read-only filesystem (except /tmp), so we cannot write to logs/
  if (process.env.VERCEL || config.ENV === 'production') {
    return [];
  }
  return [
    new transports.File({
      filename: path.join(__dirname, '../../logs', `${config.ENV}.log`),
      level: 'info',
      format: format.combine(format.timestamp(), fileLogFormat),
    }),
  ];
};

// --------------------
// MongoDB transport
// --------------------
const mongoTransport = (): MongoDBTransportInstance[] => {
  if (process.env.VERCEL || !config.DATABASE_URL) {
    return [];
  }
  return [
    new transports.MongoDB({
      level: 'info',
      db: config.DATABASE_URL as string,
      collection: 'application-logs',
      metaKey: 'meta',
      expireAfterSeconds: 3600 * 24 * 30, // 30 days
      options: { useUnifiedTopology: true },
    }),
  ];
};

// --------------------
// Trace ids (spec 017): a line written during a traced request names its trace, so an alert or
// audit line leads to the full request. Nothing is added when tracing is off.
// --------------------
export const withTraceIds = format((info) => {
  const span = trace.getActiveSpan()?.spanContext();
  if (span && isSpanContextValid(span)) {
    info.traceId = span.traceId;
    info.spanId = span.spanId;
  }
  return info;
});

// --------------------
// Logger instance
// --------------------
const logger = createLogger({
  format: withTraceIds(),
  defaultMeta: { meta: {} },
  transports: [...fileTransport(), ...mongoTransport(), ...consoleTransport()],
});

export default logger;
