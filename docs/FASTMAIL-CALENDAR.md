# Fastmail Calendar Integration

Dual-mode calendar integration for NanoClaw with Fastmail CalDAV:
- **Tool Mode**: Agents can manage calendars when asked from any channel
- **Channel Mode**: Calendar events trigger the agent automatically

## Features

### Tool Mode (MCP Tools)
Available to all agents via `mcp__calendar__*` tools:
- List all calendars
- List events within a timeframe
- Create new events
- Delete events by UID

### Channel Mode (Auto-triggering)
Each calendar becomes a registered group that receives:
- New event notifications
- Event update notifications
- Event deletion notifications
- 15-minute advance reminders

## Setup

### 1. Create App-Specific Password

1. Log into Fastmail web interface
2. Go to Settings → Password & Security → App Passwords
3. Create a new app password with CalDAV access
4. Copy the generated password

### 2. Configure Credentials

Create the credentials file:

```bash
mkdir -p ~/.fastmail-calendar
cat > ~/.fastmail-calendar/credentials.json <<EOF
{
  "username": "your-email@fastmail.com",
  "password": "your-app-specific-password",
  "baseUrl": "https://caldav.fastmail.com"
}
EOF
chmod 600 ~/.fastmail-calendar/credentials.json
```

**Note**: The `baseUrl` field is optional and defaults to `https://caldav.fastmail.com`.

### 3. Rebuild and Restart

```bash
npm run build
systemctl --user restart nanoclaw  # Linux
# or
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

## Verification

### Test Tool Mode

From your main group (WhatsApp/Telegram/etc):
```
list my calendars
```

Expected response: List of all your Fastmail calendars.

```
show events this week
```

Expected response: Events from all calendars for the current week.

```
create a test event tomorrow at 2pm for 1 hour
```

Expected response: Confirmation of event creation with UID.

### Test Channel Mode

1. Create an event in Fastmail web UI
2. Wait up to 5 minutes (default poll interval)
3. Check that a new calendar group appears in `groups/calendar_<name>/`
4. Verify agent receives notification about the new event

Create an event with a 15-minute start time to test reminders.

## Configuration

Optional environment variables in `.env`:

```bash
# Polling interval for checking calendar changes (default: 5 minutes)
FASTMAIL_CALENDAR_POLL_INTERVAL=300000

# Reminder check interval (default: 1 minute)
FASTMAIL_CALENDAR_REMINDER_INTERVAL=60000

# Minutes before event to send reminder (default: 15)
FASTMAIL_CALENDAR_REMINDER_ADVANCE=15
```

## Calendar Groups

Each calendar is automatically registered as a separate group:

- **JID Format**: `calendar:username@fastmail.com/calendar-name`
- **Folder**: `groups/calendar_<name>/`
- **Auto-activation**: `requiresTrigger: false` (events trigger agent automatically)
- **Isolated Context**: Each calendar has its own `CLAUDE.md` and conversation history

## Architecture

### Message Flow
```
Fastmail CalDAV ↔ Channel (polling) → SQLite → Agent Container → MCP Tools → CalDAV API
```

### Components
1. **CalDAV MCP Server** (`caldav-mcp` npm package)
   - Provides calendar tools to agents
   - Configured in `container/agent-runner/src/index.ts`
   - Credentials mounted read-only from `~/.fastmail-calendar/`

2. **Calendar Channel** (`src/channels/fastmail-calendar.ts`)
   - Polls Fastmail for event changes (new, updated, deleted)
   - Checks for upcoming events (15-min reminder)
   - Formats events as messages
   - Auto-registers calendars as groups

3. **Credential Storage** (`~/.fastmail-calendar/credentials.json`)
   - Outside project root for security
   - Mounted read-only to containers
   - Never exposed directly to agents

## Event Formats

### New Event
```
[New Event: Team Standup]

Starts: Mar 15, 2026, 9:00 AM
Ends: Mar 15, 2026, 9:30 AM
Calendar: Work
```

### Updated Event
```
[Updated Event: Team Standup]

Start: Mar 15, 2026, 9:00 AM → Mar 15, 2026, 10:00 AM

Calendar: Work
```

### Deleted Event
```
[Deleted Event: Team Standup]

Was scheduled: Mar 15, 2026, 9:00 AM - Mar 15, 2026, 9:30 AM
Calendar: Work
```

### Reminder
```
[Reminder: Team Standup]

Starts in 15 minutes at Mar 15, 2026, 9:00 AM
Calendar: Work
```

## Troubleshooting

### Calendar not appearing as a group
- Check credentials file exists: `ls -la ~/.fastmail-calendar/`
- Verify credentials are valid: username and password fields present
- Check logs: `tail -f data/nanoclaw.log`
- Look for "Fastmail Calendar channel enabled" message

### Events not triggering
- Verify polling is active: check logs for "Started calendar polling"
- Create/modify event in Fastmail and wait up to 5 minutes
- Check calendar group folder created: `ls -la groups/calendar_*/`
- Review sync state in logs

### Tools not available to agents
- Verify container was rebuilt after adding credentials
- Check MCP server configuration in agent-runner logs
- Ensure `mcp__calendar__*` in allowedTools array
- Verify credentials mounted to `/workspace/.fastmail-calendar/` in container

### Authentication errors
- Confirm app password (not account password) is being used
- Check Fastmail app password has CalDAV permissions
- Verify baseUrl is correct (default: `https://caldav.fastmail.com`)

## Security Notes

- Credentials stored outside project root (`~/.fastmail-calendar/`)
- Mounted read-only to containers (no container write access)
- Never exposed directly to agents (MCP proxy pattern)
- Each calendar gets isolated group folder (no cross-calendar data leakage)
- Rate limiting via poll interval prevents API abuse

## Disabling

### Tool Mode Only
To keep calendar tools but disable auto-triggering:

```bash
# Remove channel registration
# Comment out this line in src/channels/index.ts:
# import './fastmail-calendar-register.js';

npm run build
systemctl --user restart nanoclaw  # or launchctl kickstart on macOS
```

Calendar tools remain available via MCP, but events won't trigger the agent.

### Complete Removal
```bash
# Remove credentials
rm -rf ~/.fastmail-calendar/

# Rebuild and restart
npm run build
systemctl --user restart nanoclaw
```

## Advanced Usage

### Multiple Calendars
Each calendar becomes a separate group with isolated context. The main group can still query across all calendars using the MCP tools.

### Recurring Events
Recurring events are stored with their RRULE pattern. The channel expands upcoming occurrences for notifications.

### Read-Only Calendars
Shared or read-only calendars are detected via CalDAV permissions. Write operations are skipped for these calendars, and a `[Read-Only]` prefix appears in notifications.

### Timezone Handling
- Events stored internally in UTC
- Displayed in user's local timezone (from `TIMEZONE` config in `.env`)
- Uses `TZ` env var passed to containers

## References

- [CalDAV RFC 4791](https://www.rfc-editor.org/rfc/rfc4791)
- [tsdav GitHub](https://github.com/natelindev/tsdav)
- [caldav-mcp npm package](https://www.npmjs.com/package/caldav-mcp)
- [Fastmail CalDAV Documentation](https://www.fastmail.com/help/technical/server.html)

## Support

For issues or questions:
- Check logs: `tail -f data/nanoclaw.log`
- Review credential file permissions: `ls -la ~/.fastmail-calendar/`
- Test CalDAV connection manually with `curl`:
  ```bash
  curl -u "username:password" https://caldav.fastmail.com/.well-known/caldav
  ```
- Report issues at https://github.com/qwibitai/nanoclaw/issues
