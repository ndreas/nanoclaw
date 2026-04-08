import * as IRC from 'irc-framework';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { getRegisteredGroup } from '../db.js';
import * as fs from 'fs';
import * as path from 'path';

const log = logger.child({ channel: 'irc' });

export class IrcChannel implements Channel {
  name = 'irc';
  private client: IRC.Client | null = null;
  private connected = false;
  private historyFetchedNicks = new Set<string>();
  // Buffer: chatJid → messages accumulated during a chathistory batch
  private historyBuffer = new Map<
    string,
    Array<{
      from: string;
      timestamp: string;
      content: string;
      isBotMsg: boolean;
    }>
  >();
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private registerGroupFn: (jid: string, group: RegisteredGroup) => void;
  private config: {
    server: string;
    port: number;
    nick: string;
    saslUser: string;
    saslPass: string;
    channels: string[];
  };

  constructor(
    onMessage: OnInboundMessage,
    onChatMetadata: OnChatMetadata,
    registerGroup: (jid: string, group: RegisteredGroup) => void,
  ) {
    this.onMessage = onMessage;
    this.onChatMetadata = onChatMetadata;
    this.registerGroupFn = registerGroup;

    // Load config from environment
    const env = readEnvFile([
      'IRC_SERVER',
      'IRC_PORT',
      'IRC_NICK',
      'IRC_SASL_USER',
      'IRC_SASL_PASS',
      'IRC_CHANNELS',
    ]);

    const server = env.IRC_SERVER;
    const port = parseInt(env.IRC_PORT || '6697', 10);
    const nick = env.IRC_NICK;
    const saslUser = env.IRC_SASL_USER;
    const saslPass = env.IRC_SASL_PASS;
    const channels = (env.IRC_CHANNELS || '')
      .split(',')
      .map((c: string) => c.trim())
      .filter((c: string) => c);

    if (!server || !nick || !saslUser || !saslPass) {
      throw new Error(
        'Missing IRC configuration. Required: IRC_SERVER, IRC_NICK, IRC_SASL_USER, IRC_SASL_PASS',
      );
    }

    this.config = { server, port, nick, saslUser, saslPass, channels };
  }

  async connect(): Promise<void> {
    log.info(
      {
        server: this.config.server,
        port: this.config.port,
        nick: this.config.nick,
      },
      'Connecting to IRC',
    );

    this.client = new IRC.Client();

    // Set up event handlers before connecting
    this.client.on('registered', () => {
      log.info('IRC registered successfully');
      this.connected = true;

      // Join configured channels and auto-register them
      for (const channel of this.config.channels) {
        log.info({ channel }, 'Joining channel');
        this.client!.join(channel);
        this.autoRegisterChannel(channel);
      }
    });

    this.client.on('close', () => {
      log.warn('IRC connection closed');
      this.connected = false;
    });

    this.client.on('error', (err: Error) => {
      log.error({ err }, 'IRC error');
    });

    // Handle all messages (both private and channel)
    this.client.on('message', (event: any) => {
      this.handleMessage(event);
    });

    // Request chathistory after joining each channel
    this.client.on('join', (event: any) => {
      if (event.nick === this.config.nick) {
        this.requestChatHistory(event.channel);
      }
    });

    // Write history file once a full chathistory batch has arrived
    this.client.on('batch end chathistory', () => {
      for (const [chatJid, messages] of this.historyBuffer) {
        this.writeHistoryFile(chatJid, messages);
      }
      this.historyBuffer.clear();
    });

    // Request caps for soju chathistory support
    (this.client as any).requestCap([
      'draft/chathistory',
      'server-time',
      'batch',
      'message-tags',
    ]);

    // Connect with SASL auth
    this.client.connect({
      host: this.config.server,
      port: this.config.port,
      nick: this.config.nick,
      tls: this.config.port === 6697,
      account: {
        account: this.config.saslUser,
        password: this.config.saslPass,
      },
    });

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('IRC connection timeout'));
      }, 30000);

      this.client!.once('registered', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.client!.once('close', () => {
        clearTimeout(timeout);
        reject(new Error('IRC connection failed'));
      });
    });
  }

  private handleMessage(event: any): void {
    if (!this.client) return;

    const from = event.nick;
    const target = event.target;
    const message = event.message;
    const isPrivate = target.toLowerCase() === this.config.nick.toLowerCase();
    const isMentioned = message
      .toLowerCase()
      .includes(this.config.nick.toLowerCase());

    // Chathistory batch messages from soju — store as context, don't trigger agent
    if (event.batch?.type === 'chathistory') {
      const isBotMsg = from.toLowerCase() === this.config.nick.toLowerCase();
      // For bot's own sent PMs, target is the peer; for everything else use normal logic
      const chatJid =
        isPrivate || !isBotMsg
          ? isPrivate
            ? `irc:${from}`
            : `irc:${target}`
          : `irc:${target}`;
      const timestamp = event.tags?.time || new Date().toISOString();
      const msgid = event.tags?.msgid || `hist-${timestamp}-${from}`;
      this.onMessage(chatJid, {
        id: msgid,
        chat_jid: chatJid,
        sender: `irc:${from}`,
        sender_name: from,
        content: message,
        timestamp,
        is_from_me: isBotMsg,
        is_bot_message: isBotMsg,
      });
      // Accumulate for history file
      const buf = this.historyBuffer.get(chatJid) ?? [];
      buf.push({ from, timestamp, content: message, isBotMsg });
      this.historyBuffer.set(chatJid, buf);
      return;
    }

    // Only respond to:
    // 1. Private messages
    // 2. Channel messages where we're mentioned
    if (!isPrivate && !isMentioned) {
      return;
    }

    // Build JID: irc:channel for channels, irc:nick for private messages
    const chatJid = isPrivate ? `irc:${from}` : `irc:${target}`;

    // Auto-register private message senders and fetch history once per session
    if (isPrivate) {
      this.autoRegisterPrivateMessage(from);
      if (!this.historyFetchedNicks.has(from)) {
        this.historyFetchedNicks.add(from);
        this.requestChatHistory(from);
      }
    }

    log.info(
      {
        from,
        target,
        isPrivate,
        isMentioned,
        chatJid,
      },
      'Received IRC message',
    );

    // Notify about chat metadata
    this.onChatMetadata(
      chatJid,
      new Date().toISOString(),
      isPrivate ? from : target,
      'irc',
      !isPrivate,
    );

    // Clean message if mentioned in channel
    let cleanMessage = message;
    if (!isPrivate && isMentioned) {
      // Remove the mention from the message
      cleanMessage = message
        .replace(new RegExp(`@?${this.config.nick}:?\\s*`, 'gi'), '')
        .trim();
    }

    // Deliver message
    this.onMessage(chatJid, {
      id: `${Date.now()}-${from}`,
      chat_jid: chatJid,
      sender: `irc:${from}`,
      sender_name: from,
      content: cleanMessage,
      timestamp: new Date().toISOString(),
      is_from_me: false,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client || !this.connected) {
      throw new Error('IRC not connected');
    }

    // Parse JID: irc:target
    const target = jid.replace('irc:', '');

    log.info({ target, length: text.length }, 'Sending IRC message');

    // Split long messages
    const maxLength = 400; // IRC has ~512 byte limit per message
    const lines = text.split('\n');
    const chunks: string[] = [];

    for (const line of lines) {
      if (line.length <= maxLength) {
        chunks.push(line);
      } else {
        // Split long line into chunks
        for (let i = 0; i < line.length; i += maxLength) {
          chunks.push(line.slice(i, i + maxLength));
        }
      }
    }

    // Send chunks with small delay to avoid flooding
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      this.client.say(target, chunks[i]);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('irc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      log.info('Disconnecting from IRC');
      this.client.quit('Goodbye');
      this.client = null;
      this.connected = false;
    }
  }

  private autoRegisterChannel(channel: string): void {
    const chatJid = `irc:${channel}`;
    const existing = getRegisteredGroup(chatJid);

    if (existing) {
      log.debug({ channel, chatJid }, 'IRC channel already registered');
      return;
    }

    // Create folder name: irc-channelname (remove # and sanitize)
    const folderName = `irc-${channel.replace(/^#/, '').toLowerCase()}`;
    const groupFolder = path.join(process.cwd(), 'groups', folderName);
    const debugFolder = path.join(
      process.cwd(),
      'data/sessions',
      folderName,
      '.claude/debug',
    );
    const backupsFolder = path.join(
      process.cwd(),
      'data/sessions',
      folderName,
      '.claude/backups',
    );
    const ipcFolder = path.join(process.cwd(), 'data/ipc', folderName);

    // Create group folder and required subdirectories
    fs.mkdirSync(path.join(groupFolder, 'logs'), { recursive: true });
    fs.mkdirSync(debugFolder, { recursive: true });
    fs.mkdirSync(backupsFolder, { recursive: true });
    fs.mkdirSync(ipcFolder, { recursive: true });

    // Set permissions for container access
    fs.chmodSync(debugFolder, 0o777);
    fs.chmodSync(backupsFolder, 0o777);
    fs.chmodSync(ipcFolder, 0o777);

    // Create CLAUDE.md if it doesn't exist
    const claudeMdPath = path.join(groupFolder, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      const claudeMdContent = `# IRC ${channel} Channel

You are a helpful assistant in the ${channel} IRC channel. You respond when mentioned by your nickname (${this.config.nick}).

## What You Can Do

- Answer questions and have conversations
- Search the web and fetch content from URLs
- **Browse the web** with \`agent-browser\` — open pages, click, fill forms, take screenshots, extract data
- Read and write files in your workspace
- Run bash commands in your sandbox
- Send messages back to the IRC channel

## Communication

Your output is sent to the ${channel} channel on IRC.

You also have \`mcp__nanoclaw__send_message\` which sends a message immediately while you're still working.

### Internal thoughts

If part of your output is internal reasoning rather than something for the user, wrap it in \`<internal>\` tags - this text is logged but not sent to IRC.

## IRC Formatting

- Keep messages concise - IRC has message length limits
- Don't use markdown formatting (no **bold**, no _italic_, no ## headers)
- Long responses will be automatically split into multiple messages
- Use plain text formatting

## Memory

The \`conversations/\` folder contains searchable history of past conversations in ${channel}. Use this to recall context from previous sessions.

When you learn something important:
- Create files for structured data (e.g., \`notes.md\`, \`references.md\`)
- Keep an index in your memory for the files you create
`;
      fs.writeFileSync(claudeMdPath, claudeMdContent, 'utf-8');
    }

    // Register the channel (updates both in-memory state and DB)
    const group = {
      name: channel,
      folder: folderName,
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      isMain: false,
    };

    this.registerGroupFn(chatJid, group);

    log.info(
      { channel, chatJid, folder: folderName },
      'Auto-registered IRC channel',
    );
  }

  private requestChatHistory(ircTarget: string): void {
    if (!this.client || !this.connected) return;
    log.info({ target: ircTarget }, 'Requesting chathistory from soju');
    (this.client as any).raw('CHATHISTORY', 'LATEST', ircTarget, '*', '100');
  }

  private writeHistoryFile(
    chatJid: string,
    messages: Array<{
      from: string;
      timestamp: string;
      content: string;
      isBotMsg: boolean;
    }>,
  ): void {
    if (messages.length === 0) return;

    const group = getRegisteredGroup(chatJid);
    if (!group) return;

    const groupFolder = path.join(process.cwd(), 'groups', group.folder);
    const conversationsDir = path.join(groupFolder, 'conversations');
    fs.mkdirSync(conversationsDir, { recursive: true });

    const lines = messages.map(({ from, timestamp, content }) => {
      const timeStr = timestamp ? new Date(timestamp).toLocaleString() : '';
      return `[${timeStr}] <${from}> ${content}`;
    });

    const historyFile = path.join(conversationsDir, 'irc-log.md');
    fs.writeFileSync(
      historyFile,
      `# IRC Chat History\n\n${lines.join('\n')}\n`,
      'utf-8',
    );
    log.info(
      { folder: group.folder, messageCount: messages.length },
      'Wrote chathistory to file',
    );
  }

  private sanitizeNicknameForFolder(nickname: string): string {
    // Convert to lowercase and sanitize for folder name
    let sanitized = nickname
      .toLowerCase()
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/[^a-z0-9_-]/g, ''); // Remove non-alphanumeric chars except _ and -

    // Ensure starts with alphanumeric
    sanitized = sanitized.replace(/^[^a-z0-9]+/, '');

    // Limit to 50 chars (leaving room for irc-pm- prefix = 57 chars total)
    sanitized = sanitized.slice(0, 50);

    // Fallback to hash if empty/invalid
    if (!sanitized || sanitized.length === 0) {
      const crypto = require('crypto');
      const hash = crypto.createHash('md5').update(nickname).digest('hex');
      sanitized = `user-${hash}`;
    }

    return sanitized;
  }

  private autoRegisterPrivateMessage(nickname: string): void {
    const chatJid = `irc:${nickname}`;
    const existing = getRegisteredGroup(chatJid);

    if (existing) {
      log.debug(
        { nickname, chatJid },
        'IRC private message already registered',
      );
      return;
    }

    // Create folder name: irc-pm-{sanitized-nickname}
    const sanitizedNick = this.sanitizeNicknameForFolder(nickname);
    const folderName = `irc-pm-${sanitizedNick}`;
    const groupFolder = path.join(process.cwd(), 'groups', folderName);
    const debugFolder = path.join(
      process.cwd(),
      'data/sessions',
      folderName,
      '.claude/debug',
    );
    const backupsFolder = path.join(
      process.cwd(),
      'data/sessions',
      folderName,
      '.claude/backups',
    );
    const ipcFolder = path.join(process.cwd(), 'data/ipc', folderName);

    // Create group folder and required subdirectories
    fs.mkdirSync(path.join(groupFolder, 'logs'), { recursive: true });
    fs.mkdirSync(debugFolder, { recursive: true });
    fs.mkdirSync(backupsFolder, { recursive: true });
    fs.mkdirSync(ipcFolder, { recursive: true });

    // Set permissions for container access
    fs.chmodSync(debugFolder, 0o777);
    fs.chmodSync(backupsFolder, 0o777);
    fs.chmodSync(ipcFolder, 0o777);

    // Create CLAUDE.md if it doesn't exist
    const claudeMdPath = path.join(groupFolder, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      const claudeMdContent = `# IRC Private Message with ${nickname}

You are having a private conversation with ${nickname} on IRC.

## What You Can Do

- Answer questions and have conversations
- Search the web and fetch content from URLs
- **Browse the web** with \`agent-browser\` — open pages, click, fill forms, take screenshots, extract data
- Read and write files in your workspace
- Run bash commands in your sandbox
- Send messages back to ${nickname}

## Communication

Your output is sent directly to ${nickname} via IRC private message.

You also have \`mcp__nanoclaw__send_message\` which sends a message immediately while you're still working.

### Internal thoughts

If part of your output is internal reasoning rather than something for the user, wrap it in \`<internal>\` tags - this text is logged but not sent to IRC.

## IRC Formatting

- Keep messages concise - IRC has message length limits
- Don't use markdown formatting (no **bold**, no _italic_, no ## headers)
- Long responses will be automatically split into multiple messages
- Use plain text formatting

## Memory

The \`conversations/\` folder contains searchable history of your private conversation with ${nickname}. Use this to recall context from previous sessions.

When you learn something important:
- Create files for structured data (e.g., \`notes.md\`, \`references.md\`)
- Keep an index in your memory for the files you create
`;
      fs.writeFileSync(claudeMdPath, claudeMdContent, 'utf-8');
    }

    // Register the private message group (updates both in-memory state and DB)
    const group = {
      name: `PM: ${nickname}`,
      folder: folderName,
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false, // All private messages should be processed
      isMain: false,
    };

    this.registerGroupFn(chatJid, group);

    log.info(
      { nickname, chatJid, folder: folderName },
      'Auto-registered IRC private message',
    );
  }
}
