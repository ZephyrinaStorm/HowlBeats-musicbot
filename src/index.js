'use strict';

const { spawn } = require('node:child_process');
const { Client, Events, GatewayIntentBits, ChannelType, PermissionsBitField } = require('discord.js');
const { joinVoiceChannel, entersState, VoiceConnectionStatus, createAudioPlayer,
  createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, StreamType } = require('@discordjs/voice');
const ffmpeg = require('ffmpeg-static');

const token = process.env.BOT_TOKEN?.trim();
const streamUrl = process.env.STREAM_URL?.trim() || 'https://furzona.radio/listen/clubradio/stream.mp3';
const channelId = process.env.STAGECHANNEL_ID?.trim();
if (!token || !streamUrl || !/^\d{17,20}$/.test(channelId || '')) {
  console.error('Set BOT_TOKEN, STREAM_URL, and a valid STAGECHANNEL_ID.');
  process.exit(1);
}
try {
  if (!['http:', 'https:'].includes(new URL(streamUrl).protocol)) throw new Error();
} catch {
  console.error('STREAM_URL must be a direct HTTP or HTTPS radio audio stream.');
  process.exit(1);
}

// Never print tokens, stream URLs, FFmpeg stderr, or raw API exceptions.
const log = (message) => console.log(new Date().toISOString(), message);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
let connection, decoder, retryTimer, watchdog, stopping = false, busy = false;
let failures = 0, lastAudio = Date.now(), pendingRecovery = false;

function stopAudio() {
  const old = decoder;
  decoder = undefined;
  if (old) {
    old.stdout.destroy();
    old.kill('SIGKILL');
  }
  player.stop(true);
}

function recover(reason) {
  if (stopping || retryTimer) return;
  if (busy) { pendingRecovery = true; return; }
  stopAudio();
  const delay = Math.min(60000, 5000 * 2 ** Math.min(failures++, 4));
  log(`${reason}; retrying in ${delay / 1000}s.`);
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void startRadio();
  }, delay);
}

async function startRadio() {
  if (busy || stopping) return;
  busy = true;
  pendingRecovery = false;
  let step = 'checking Discord gateway';
  try {
    if (!client.isReady()) throw new Error('gateway');
    step = 'fetching Stage channel';
    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildStageVoice) {
      log('STAGECHANNEL_ID must identify a Stage channel, not a text or ordinary voice channel.');
      throw new Error('stage');
    }
    step = 'fetching bot member';
    const me = await channel.guild.members.fetchMe();
    const needed = ['ViewChannel', 'Connect', 'Speak', 'MuteMembers', 'MoveMembers', 'ManageChannels']
      .map(name => PermissionsBitField.Flags[name]);
    if (!channel.permissionsFor(me)?.has(needed)) {
      log('Missing Stage permissions. See README: View Channel, Connect, Speak, Mute Members, Move Members, Manage Channels.');
      throw new Error('permissions');
    }
    step = 'connecting to Discord voice';
    if (connection?.state.status !== VoiceConnectionStatus.Ready || me.voice.channelId !== channelId) {
      if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      connection = joinVoiceChannel({ channelId, guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: true, selfMute: false });
      connection.on('error', () => recover('Voice connection error'));
      connection.on('stateChange', (oldState, newState) => {
        if (connection?.state !== newState) return;
        if ([VoiceConnectionStatus.Disconnected, VoiceConnectionStatus.Destroyed].includes(newState.status)) {
          recover('Voice disconnected');
        }
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 30000);
    }
    if (stopping) return;
    // Preserve any existing Stage topic. Create a session only when absent.
    step = 'fetching Stage session';
    let stage;
    try {
      stage = await channel.guild.stageInstances.fetch(channelId);
    } catch (error) {
      if (error.code !== 10067) throw error; // Unknown Stage Instance: create one.
    }
    step = 'creating Stage session';
    if (!stage) stage = await channel.createStageInstance({ topic: '24/7 Radio', privacyLevel: 2 });
    step = 'becoming a Stage speaker';
    await me.voice.setSuppressed(false);
    if (stopping) return;
    if (me.voice.serverMute) {
      log('Bot is server-muted. Unmute it in Discord to hear the radio.');
      throw new Error('muted');
    }
    connection.subscribe(player);
    stopAudio();
    step = 'starting audio encoder';
    const proc = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-rw_timeout', '15000000', '-reconnect', '1', '-reconnect_streamed', '1',
      '-reconnect_at_eof', '1', '-reconnect_delay_max', '5',
      '-i', streamUrl, '-vn', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    decoder = proc;
    lastAudio = Date.now();
    proc.stdout.on('data', () => { lastAudio = Date.now(); });
    proc.on('error', () => { if (decoder === proc) recover('Could not start FFmpeg'); });
    proc.on('close', () => { if (decoder === proc) recover('Radio stream ended'); });
    const resource = createAudioResource(proc.stdout, { inputType: StreamType.Raw });
    player.play(resource);
    log('Connected to the Stage; radio playback starting.');
  } catch (error) {
    pendingRecovery = true;
    const code = typeof error.code === 'number' ? ` Discord code ${error.code}.` : '';
    log(`Unable to start radio while ${step}.${code}`);
    if (error.code === 50013 || error.code === 50001) log('Discord denied access. Check the bot role and Stage channel permission overrides.');
    if (error.code === 10003) log('Unknown channel. Check STAGECHANNEL_ID and that the bot belongs to that server.');
    if (step === 'connecting to Discord voice') log('Voice did not become ready. Check Connect permission, duplicate bot deployments, and host outbound UDP connectivity.');
  } finally {
    busy = false;
    if (pendingRecovery && !stopping) recover('Radio needs recovery');
  }
}

player.on('error', () => recover('Audio player error'));
player.on(AudioPlayerStatus.Idle, () => { if (decoder) recover('Playback stopped'); });
player.on(AudioPlayerStatus.Playing, () => log('Radio is playing.'));
client.on(Events.Error, () => log('Discord gateway error; waiting for reconnect.'));
client.on(Events.VoiceStateUpdate, (oldState, state) => {
  if (state.id !== client.user?.id || stopping) return;
  if (state.channelId !== channelId || state.suppress || state.serverMute) recover('Bot moved, suppressed, or muted');
});
client.once(Events.ClientReady, () => {
  log('Discord login successful.');
  void startRadio();
  watchdog = setInterval(() => {
    if (stopping || busy || retryTimer || !client.isReady()) return;
    if (!decoder || Date.now() - lastAudio > 45000 || connection?.state.status !== VoiceConnectionStatus.Ready) {
      recover('Playback watchdog detected an interruption');
    } else if (player.state.status === AudioPlayerStatus.Playing) failures = 0;
  }, 15000);
});

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(retryTimer);
  clearInterval(watchdog);
  stopAudio();
  if (connection?.state.status !== VoiceConnectionStatus.Destroyed) connection?.destroy();
  client.destroy();
  log('Bot stopped.');
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2000).unref();
}
process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
process.on('uncaughtException', () => { log('Unexpected fatal error; exiting for host restart.'); shutdown(1); });
process.on('unhandledRejection', () => { log('Unhandled failure; exiting for host restart.'); shutdown(1); });
client.login(token).catch(() => { log('Discord login failed. Check BOT_TOKEN.'); shutdown(1); });
