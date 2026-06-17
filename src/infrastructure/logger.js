import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.logLevel,
  base: { service: 'infoclic' },
  timestamp: pino.stdTimeFunctions.isoTime,
});
