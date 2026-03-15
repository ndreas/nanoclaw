import { registerChannel } from './registry.js';
import { IrcChannel } from './irc.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'irc-register' });

// Auto-register IRC channel if credentials are present
registerChannel('irc', (opts) => {
  const env = readEnvFile([
    'IRC_SERVER',
    'IRC_NICK',
    'IRC_SASL_USER',
    'IRC_SASL_PASS',
  ]);

  const hasConfig =
    env.IRC_SERVER && env.IRC_NICK && env.IRC_SASL_USER && env.IRC_SASL_PASS;

  if (!hasConfig) {
    log.debug('IRC channel disabled - missing configuration');
    return null;
  }

  log.info('IRC channel enabled');
  return new IrcChannel(opts.onMessage, opts.onChatMetadata);
});
