import { registerChannel } from './registry.js';
import { FastmailCalendarChannel } from './fastmail-calendar.js';
import { logger } from '../logger.js';
import * as fs from 'fs';
import * as path from 'path';

const log = logger.child({ module: 'fastmail-calendar-register' });

// Auto-register Fastmail Calendar channel if credentials are present
registerChannel('fastmail-calendar', (opts) => {
  const credsPath = path.join(
    process.env.HOME || '/home/node',
    '.fastmail-calendar',
    'credentials.json',
  );

  if (!fs.existsSync(credsPath)) {
    log.debug('Fastmail Calendar channel disabled - missing credentials file');
    return null;
  }

  try {
    const credentials = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));

    if (!credentials.username || !credentials.password) {
      log.warn('Fastmail Calendar credentials missing username or password');
      return null;
    }

    log.info('Fastmail Calendar channel enabled');
    return new FastmailCalendarChannel(
      credentials,
      opts.onMessage,
      opts.onChatMetadata,
    );
  } catch (error) {
    log.error({ error }, 'Failed to load Fastmail Calendar credentials');
    return null;
  }
});
