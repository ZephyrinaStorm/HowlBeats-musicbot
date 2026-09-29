# Discord Stage Radio — 24/7

Automatically joins one Discord Stage channel and plays your radio stream, including when nobody is listening. Restarts interrupted streams with a bounded retry delay, reconnects after voice interruptions, checks for stalled audio, and shuts down cleanly on Render redeploys. No commands or website are required.

## 1. Set up Discord

1. Create an application at https://discord.com/developers/applications and create its bot. Copy the bot token privately.
2. Under OAuth2 → URL Generator, select the **bot** scope. Invite the bot to your server. No privileged intents are required.
3. Use an existing **Stage channel** in a Community server. Enable Developer Mode in Discord, right-click the Stage channel, and copy its channel ID.
4. Give the bot these permissions in that Stage channel: **View Channel, Connect, Speak, Mute Members, Move Members, Manage Channels**. These Stage moderator permissions let it start a Stage session and become a speaker automatically. Check channel overrides too; Administrator is not required.
5. The bot preserves an existing Stage topic. If no Stage session exists, it creates one named **24/7 Radio**. It does not delete the Stage session on exit. If the bot is server-muted, unmute it manually.

## 2. Upload to GitHub

Extract this ZIP and upload the contents of `discord-radio-bot` to the repository root, including `src`, `package.json`, `package-lock.json`, `render.yaml`, and `.node-version`. Do not upload `node_modules` or a real `.env` file. `.env.example` contains placeholders only.

## 3. Deploy on Render

### Blueprint option

Render → **New → Blueprint** → connect your GitHub repository. Render reads `render.yaml`. Review the paid Starter worker plan and fill the three environment variables before deploying.

### Manual option

Render → **New → Background Worker** → select the repository.

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Build command | `npm ci` |
| Start command | `npm start` |
| Instance plan | Paid Starter or higher |
| Instances | 1 |

If you uploaded the folder itself instead of its contents, set Root Directory to `discord-radio-bot`.

Add exactly these application environment variables:

| Variable | Value |
| --- | --- |
| `BOT_TOKEN` | Your Discord bot token |
| `STREAM_URL` | `https://furzona.radio/listen/clubradio/stream.mp3` (included default; can be overridden) |
| `STAGECHANNEL_ID` | Numeric Stage channel ID |

Node is pinned by `.node-version`. No PORT, client ID, guild ID, or slash-command registration is needed. Keep one instance and stop any local copy before starting the Render copy.

**Continuous hosting requires a paid service:** Background Workers do not have a free instance plan. Free web services sleep and are unsuitable for this bot. See https://render.com/docs/background-workers and https://render.com/docs/free. Deploys, Discord outages, stream outages, or host restarts can briefly interrupt playback; 24/7 is the bot's intended operation, not a guarantee of zero downtime.

## Stream formats

Use a direct Icecast/Shoutcast MP3 or AAC endpoint, or a direct HLS `.m3u8` stream supported by FFmpeg. A radio station webpage, YouTube page, Spotify link, or playlist webpage is not an audio endpoint. The stream must work without a browser login. This build does not supply custom authorization headers. Credentials in a stream URL are treated as secret and are not logged.

## Local run

Install Node.js 24.17 or newer in the Node 24 release line. Copy `.env.example` to `.env`, fill its values, then run:

```sh
npm ci
npm start
```

The package includes FFmpeg and a JavaScript Opus encoder; no separate FFmpeg installation is needed on Render Linux x64. Discord voice encryption support is included through `@discordjs/voice` and its DAVE dependency.

## Troubleshooting

- **Login failed:** check the token in Render. Reset a token that was exposed, then update Render.
- **Unable to start radio:** confirm the Stage ID, all channel permissions, and that the stream is publicly reachable from the host.
- **Bot is in the audience:** give it all Stage moderator permissions above. It retries becoming a speaker.
- **Stream ended / watchdog:** check the audio endpoint. Retries begin at 5 seconds and back off to 60 seconds.
- **No sound:** make sure the bot is a speaker and is not server-muted; check your listener volume and deafened status.
- **Repeated disconnects:** run only one deployment for the token. Check Render and Discord status, and host outbound UDP connectivity.
- **Build failures:** use the included lockfile and Node version. The build needs outbound access to npm and FFmpeg's binary download.

## Validation

`npm run check` checks JavaScript syntax. The release was dependency-installed and checked locally; live Discord playback requires your token, Stage ID, and actual stream and cannot be verified without them.

### Startup diagnostics

Render may print `.env not found. Continuing without it.`; this is normal when variables are set in the dashboard. Startup failures now report the failing step and numeric Discord API code. Code 50013 means missing permissions, 50001 means missing access, and 10003 means unknown channel. Share that diagnostic line when requesting help, never your token. Stage session lookup only creates a session when Discord explicitly reports it is absent.
