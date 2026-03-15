import { createDAVClient, DAVCalendar, DAVCalendarObject } from 'tsdav';
import { Channel, OnInboundMessage, OnChatMetadata } from '../types.js';
import { logger } from '../logger.js';
import { getRegisteredGroup, setRegisteredGroup } from '../db.js';
import * as fs from 'fs';
import * as path from 'path';

const log = logger.child({ channel: 'fastmail-calendar' });

interface CalendarCredentials {
  username: string;
  password: string;
  baseUrl?: string;
}

interface EventState {
  uid: string;
  etag: string;
  summary: string;
  start: string;
  end: string;
  lastModified: string;
}

interface CalendarSyncState {
  calendarUrl: string;
  lastSync: string;
  events: Map<string, EventState>;
}

export class FastmailCalendarChannel implements Channel {
  name = 'fastmail-calendar';
  private client: any = null;
  private connected = false;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private credentials: CalendarCredentials;
  private calendars: DAVCalendar[] = [];
  private pollInterval: NodeJS.Timeout | null = null;
  private syncState: Map<string, CalendarSyncState> = new Map();
  private pollIntervalMs: number;
  private reminderIntervalMs: number;
  private reminderAdvanceMin: number;
  private lastReminderCheck: Map<string, Set<string>> = new Map();

  constructor(
    credentials: CalendarCredentials,
    onMessage: OnInboundMessage,
    onChatMetadata: OnChatMetadata,
  ) {
    this.credentials = credentials;
    this.onMessage = onMessage;
    this.onChatMetadata = onChatMetadata;

    // Read intervals from env or use defaults
    this.pollIntervalMs =
      parseInt(process.env.FASTMAIL_CALENDAR_POLL_INTERVAL || '', 10) || 300000; // 5 min
    this.reminderIntervalMs =
      parseInt(process.env.FASTMAIL_CALENDAR_REMINDER_INTERVAL || '', 10) ||
      60000; // 1 min
    this.reminderAdvanceMin =
      parseInt(process.env.FASTMAIL_CALENDAR_REMINDER_ADVANCE || '', 10) || 15; // 15 min
  }

  async connect(): Promise<void> {
    log.info('Connecting to Fastmail CalDAV');

    try {
      const baseUrl = this.credentials.baseUrl || 'https://caldav.fastmail.com';

      this.client = await createDAVClient({
        serverUrl: baseUrl,
        credentials: {
          username: this.credentials.username,
          password: this.credentials.password,
        },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
      });

      // Fetch all calendars
      this.calendars = await this.client.fetchCalendars();
      log.info(
        { count: this.calendars.length },
        'Fetched calendars from Fastmail',
      );

      // Auto-register each calendar as a group
      for (const calendar of this.calendars) {
        await this.autoRegisterCalendar(calendar);
        // Initialize sync state
        this.syncState.set(calendar.url, {
          calendarUrl: calendar.url,
          lastSync: new Date().toISOString(),
          events: new Map(),
        });
      }

      this.connected = true;

      // Start polling loop
      this.startPolling();

      log.info('Fastmail calendar channel connected successfully');
    } catch (error) {
      log.error({ error }, 'Failed to connect to Fastmail CalDAV');
      throw error;
    }
  }

  private startPolling(): void {
    // Main poll interval for event changes
    this.pollInterval = setInterval(async () => {
      try {
        for (const calendar of this.calendars) {
          await this.pollCalendar(calendar);
        }
      } catch (error) {
        log.error({ error }, 'Error during calendar polling');
      }
    }, this.pollIntervalMs);

    // Separate interval for reminders (check more frequently)
    setInterval(async () => {
      try {
        await this.checkReminders();
      } catch (error) {
        log.error({ error }, 'Error checking reminders');
      }
    }, this.reminderIntervalMs);

    log.info(
      {
        pollIntervalMs: this.pollIntervalMs,
        reminderIntervalMs: this.reminderIntervalMs,
      },
      'Started calendar polling',
    );
  }

  private async pollCalendar(calendar: DAVCalendar): Promise<void> {
    const state = this.syncState.get(calendar.url);
    if (!state) return;

    try {
      // Fetch events from last sync until 30 days from now
      const now = new Date();
      const startDate = new Date(state.lastSync);
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + 30);

      const objects = await this.client.fetchCalendarObjects({
        calendar: calendar,
        timeRange: {
          start: startDate.toISOString(),
          end: endDate.toISOString(),
        },
      });

      const currentEventUids = new Set<string>();

      // Process each event
      for (const obj of objects as DAVCalendarObject[]) {
        if (!obj.data) continue;

        const event = this.parseICalEvent(obj.data);
        if (!event) continue;

        currentEventUids.add(event.uid);
        const existingEvent = state.events.get(event.uid);

        if (!existingEvent) {
          // New event
          await this.notifyNewEvent(calendar, event);
          state.events.set(event.uid, event);
        } else if (
          existingEvent.etag !== event.etag ||
          existingEvent.lastModified !== event.lastModified
        ) {
          // Updated event
          await this.notifyUpdatedEvent(calendar, event, existingEvent);
          state.events.set(event.uid, event);
        }
      }

      // Check for deleted events
      for (const [uid, event] of state.events.entries()) {
        if (!currentEventUids.has(uid)) {
          await this.notifyDeletedEvent(calendar, event);
          state.events.delete(uid);
        }
      }

      state.lastSync = now.toISOString();
      this.syncState.set(calendar.url, state);
    } catch (error) {
      log.error({ error, calendarUrl: calendar.url }, 'Error polling calendar');
    }
  }

  private async checkReminders(): Promise<void> {
    const now = new Date();
    const reminderThreshold = new Date(
      now.getTime() + this.reminderAdvanceMin * 60 * 1000,
    );

    for (const [calendarUrl, state] of this.syncState.entries()) {
      const calendar = this.calendars.find((c) => c.url === calendarUrl);
      if (!calendar) continue;

      if (!this.lastReminderCheck.has(calendarUrl)) {
        this.lastReminderCheck.set(calendarUrl, new Set());
      }
      const alreadyReminded = this.lastReminderCheck.get(calendarUrl)!;

      for (const [uid, event] of state.events.entries()) {
        const eventStart = new Date(event.start);

        // Check if event is within reminder window and hasn't been reminded yet
        if (
          eventStart <= reminderThreshold &&
          eventStart > now &&
          !alreadyReminded.has(uid)
        ) {
          await this.notifyReminder(calendar, event);
          alreadyReminded.add(uid);
        }

        // Clean up old reminders (events that have passed)
        if (eventStart < now) {
          alreadyReminded.delete(uid);
        }
      }
    }
  }

  private parseICalEvent(icalData: string): EventState | null {
    try {
      // Basic iCal parsing - extract key fields
      const uidMatch = icalData.match(/UID:(.+)/);
      const summaryMatch = icalData.match(/SUMMARY:(.+)/);
      const dtstartMatch = icalData.match(/DTSTART[^:]*:(.+)/);
      const dtendMatch = icalData.match(/DTEND[^:]*:(.+)/);
      const lastModifiedMatch = icalData.match(/LAST-MODIFIED:(.+)/);

      if (!uidMatch || !dtstartMatch) return null;

      const uid = uidMatch[1].trim();
      const summary = summaryMatch ? summaryMatch[1].trim() : '(No title)';
      const start = this.parseICalDate(dtstartMatch[1].trim());
      const end = dtendMatch ? this.parseICalDate(dtendMatch[1].trim()) : start;
      const lastModified = lastModifiedMatch
        ? lastModifiedMatch[1].trim()
        : new Date().toISOString();

      // Use UID as etag if not available
      const etag = uid;

      return {
        uid,
        etag,
        summary,
        start,
        end,
        lastModified,
      };
    } catch (error) {
      log.error({ error, icalData }, 'Failed to parse iCal event');
      return null;
    }
  }

  private parseICalDate(dateStr: string): string {
    try {
      // Handle both formats: 20260315T090000Z and 20260315T090000
      const cleanDate = dateStr.replace(/[:-]/g, '');

      if (cleanDate.includes('T')) {
        // DateTime format
        const year = parseInt(cleanDate.substring(0, 4));
        const month = parseInt(cleanDate.substring(4, 6)) - 1;
        const day = parseInt(cleanDate.substring(6, 8));
        const hour = parseInt(cleanDate.substring(9, 11));
        const minute = parseInt(cleanDate.substring(11, 13));
        const second = parseInt(cleanDate.substring(13, 15) || '0');

        const date = cleanDate.endsWith('Z')
          ? new Date(Date.UTC(year, month, day, hour, minute, second))
          : new Date(year, month, day, hour, minute, second);

        return date.toISOString();
      } else {
        // Date only format
        const year = parseInt(cleanDate.substring(0, 4));
        const month = parseInt(cleanDate.substring(4, 6)) - 1;
        const day = parseInt(cleanDate.substring(6, 8));

        return new Date(year, month, day).toISOString();
      }
    } catch (error) {
      log.error({ error, dateStr }, 'Failed to parse iCal date');
      return new Date().toISOString();
    }
  }

  private formatEventTime(isoDate: string): string {
    const date = new Date(isoDate);
    return date.toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  private async notifyNewEvent(
    calendar: DAVCalendar,
    event: EventState,
  ): Promise<void> {
    const chatJid = this.buildCalendarJid(calendar);
    const calendarName = this.getCalendarDisplayName(calendar);

    const message = `[New Event: ${event.summary}]

Starts: ${this.formatEventTime(event.start)}
Ends: ${this.formatEventTime(event.end)}
Calendar: ${calendarName}`;

    log.info({ calendar: calendarName, event: event.summary }, 'New event');

    this.deliverMessage(chatJid, message, calendarName);
  }

  private async notifyUpdatedEvent(
    calendar: DAVCalendar,
    newEvent: EventState,
    oldEvent: EventState,
  ): Promise<void> {
    const chatJid = this.buildCalendarJid(calendar);
    const calendarName = this.getCalendarDisplayName(calendar);

    const changes: string[] = [];
    if (newEvent.summary !== oldEvent.summary) {
      changes.push(`Title: "${oldEvent.summary}" → "${newEvent.summary}"`);
    }
    if (newEvent.start !== oldEvent.start) {
      changes.push(
        `Start: ${this.formatEventTime(oldEvent.start)} → ${this.formatEventTime(newEvent.start)}`,
      );
    }
    if (newEvent.end !== oldEvent.end) {
      changes.push(
        `End: ${this.formatEventTime(oldEvent.end)} → ${this.formatEventTime(newEvent.end)}`,
      );
    }

    const message = `[Updated Event: ${newEvent.summary}]

${changes.join('\n')}

Calendar: ${calendarName}`;

    log.info(
      { calendar: calendarName, event: newEvent.summary },
      'Updated event',
    );

    this.deliverMessage(chatJid, message, calendarName);
  }

  private async notifyDeletedEvent(
    calendar: DAVCalendar,
    event: EventState,
  ): Promise<void> {
    const chatJid = this.buildCalendarJid(calendar);
    const calendarName = this.getCalendarDisplayName(calendar);

    const message = `[Deleted Event: ${event.summary}]

Was scheduled: ${this.formatEventTime(event.start)} - ${this.formatEventTime(event.end)}
Calendar: ${calendarName}`;

    log.info({ calendar: calendarName, event: event.summary }, 'Deleted event');

    this.deliverMessage(chatJid, message, calendarName);
  }

  private async notifyReminder(
    calendar: DAVCalendar,
    event: EventState,
  ): Promise<void> {
    const chatJid = this.buildCalendarJid(calendar);
    const calendarName = this.getCalendarDisplayName(calendar);

    const message = `[Reminder: ${event.summary}]

Starts in ${this.reminderAdvanceMin} minutes at ${this.formatEventTime(event.start)}
Calendar: ${calendarName}`;

    log.info(
      { calendar: calendarName, event: event.summary },
      'Event reminder',
    );

    this.deliverMessage(chatJid, message, calendarName);
  }

  private deliverMessage(
    chatJid: string,
    content: string,
    calendarName: string,
  ): void {
    // Notify about chat metadata
    this.onChatMetadata(
      chatJid,
      new Date().toISOString(),
      calendarName,
      this.name,
      false,
    );

    // Deliver message
    this.onMessage(chatJid, {
      id: `${Date.now()}-calendar`,
      chat_jid: chatJid,
      sender: chatJid,
      sender_name: calendarName,
      content,
      timestamp: new Date().toISOString(),
      is_from_me: false,
    });
  }

  private getCalendarDisplayName(calendar: DAVCalendar): string {
    if (typeof calendar.displayName === 'string') {
      return calendar.displayName;
    }
    return 'Calendar';
  }

  private sanitizeForFolderName(name: string): string {
    // Transliterate common non-ASCII characters
    const translitMap: Record<string, string> = {
      ä: 'a',
      ö: 'o',
      ü: 'u',
      å: 'a',
      Ä: 'A',
      Ö: 'O',
      Ü: 'U',
      Å: 'A',
      é: 'e',
      è: 'e',
      ê: 'e',
      ë: 'e',
      É: 'E',
      È: 'E',
      Ê: 'E',
      Ë: 'E',
      à: 'a',
      á: 'a',
      â: 'a',
      ã: 'a',
      À: 'A',
      Á: 'A',
      Â: 'A',
      Ã: 'A',
      ñ: 'n',
      Ñ: 'N',
      ç: 'c',
      Ç: 'C',
    };

    let sanitized = name;

    // Apply transliteration
    for (const [from, to] of Object.entries(translitMap)) {
      sanitized = sanitized.replace(new RegExp(from, 'g'), to);
    }

    // Convert to lowercase, replace spaces with hyphens
    sanitized = sanitized.toLowerCase().replace(/\s+/g, '-');

    // Remove any remaining non-ASCII and non-allowed characters
    sanitized = sanitized.replace(/[^a-z0-9_-]/g, '');

    // Ensure starts with alphanumeric
    sanitized = sanitized.replace(/^[^a-z0-9]+/, '');

    // Limit length to 50 chars (leaving room for 'calendar_' prefix)
    sanitized = sanitized.substring(0, 50);

    // Fallback to hash if empty or still invalid
    if (!sanitized || sanitized.length === 0) {
      const hash = require('crypto')
        .createHash('md5')
        .update(name)
        .digest('hex')
        .substring(0, 8);
      sanitized = `cal-${hash}`;
    }

    return sanitized;
  }

  private buildCalendarJid(calendar: DAVCalendar): string {
    // Extract calendar name from URL or use displayName
    const displayName = this.getCalendarDisplayName(calendar);
    const calendarId =
      displayName !== 'Calendar'
        ? displayName.toLowerCase().replace(/\s+/g, '-')
        : calendar.url.split('/').pop() || 'default';
    return `calendar:${this.credentials.username}/${calendarId}`;
  }

  private async autoRegisterCalendar(calendar: DAVCalendar): Promise<void> {
    const chatJid = this.buildCalendarJid(calendar);
    const existing = getRegisteredGroup(chatJid);

    if (existing) {
      log.debug(
        { calendar: calendar.displayName, chatJid },
        'Calendar already registered',
      );
      return;
    }

    // Create folder name: calendar_calendarname
    const calDisplayName = this.getCalendarDisplayName(calendar);
    const calendarId =
      calDisplayName !== 'Calendar'
        ? this.sanitizeForFolderName(calDisplayName)
        : 'default';
    const folderName = `calendar_${calendarId}`;
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
      const calendarDisplayName = this.getCalendarDisplayName(calendar);
      const claudeMdContent = `# ${calendarDisplayName} Channel

You are monitoring the "${calendarDisplayName}" calendar from Fastmail. You receive notifications when:
- New events are created
- Events are updated
- Events are deleted
- Events are starting soon (${this.reminderAdvanceMin} minute reminders)

## What You Can Do

- Acknowledge calendar events
- Search the web for information related to events
- **Browse the web** with \`agent-browser\` — research topics, gather information
- Read and write files in your workspace to track event-related notes
- Run bash commands in your sandbox
- Use calendar management tools via \`mcp__calendar__*\` to:
  - List all calendars
  - List events within a timeframe
  - Create new events
  - Delete events

## Communication

Your responses are context-aware acknowledgments of calendar events. Keep them brief and relevant.

You also have \`mcp__nanoclaw__send_message\` which sends a message immediately while you're still working.

### Internal thoughts

If part of your output is internal reasoning rather than something for the user, wrap it in \`<internal>\` tags - this text is logged but not sent.

## Calendar Tools

Available MCP tools for calendar management:
- \`mcp__calendar__list_calendars\`: List all available calendars
- \`mcp__calendar__list_events\`: List events within a specific timeframe
- \`mcp__calendar__create_event\`: Create a new calendar event
- \`mcp__calendar__delete_event\`: Delete an event by UID

## Memory

The \`conversations/\` folder contains searchable history of calendar events. Use this to track patterns and context.

When you learn something important:
- Create files for structured data (e.g., \`notes.md\`, \`event-tracking.md\`)
- Keep an index in your memory for the files you create
`;
      fs.writeFileSync(claudeMdPath, claudeMdContent);
    }

    // Register in database
    setRegisteredGroup(chatJid, {
      name: calDisplayName !== 'Calendar' ? calDisplayName : folderName,
      folder: folderName,
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false, // Calendar events auto-activate
      isMain: false,
    });

    log.info(
      { calendar: calendar.displayName, chatJid, folder: folderName },
      'Auto-registered calendar as group',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client || !this.connected) {
      throw new Error('Calendar not connected');
    }

    // For calendar channels, sending a message could mean creating an event
    // or updating calendar notes. For now, we'll just log it.
    log.info(
      { jid, text },
      'Calendar channel does not support outbound messages',
    );
    throw new Error(
      'Cannot send messages to calendar. Use calendar tools to create/modify events.',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('calendar:');
  }

  async disconnect(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.connected = false;
    this.client = null;
    log.info('Disconnected from Fastmail calendar');
  }
}
