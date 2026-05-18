import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.logLevel,
  base: { service: 'infoclick' },
  timestamp: pino.stdTimeFunctions.isoTime,
});
