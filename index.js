// ============================================================
// BotForge Bot - index.js
// Auto-loads ALL commands + custom code from your panel
// ============================================================

const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require("discord.js");

// Discord.js helpers for code_block access
const djs = { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder };

const BOT_TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Your bot's Application ID
const GUILD_ID  = "1481739027488182354";
const PREFIX    = "!fix";

const API_URL      = "https://app.base44.com/api/apps/69e0f31e9fcd866ea1f3ea35/entities/BotCommand";
const CONFIG_URL   = "https://app.base44.com/api/apps/69e0f31e9fcd866ea1f3ea35/entities/BotConfig";
const ROLES_URL    = "https://app.base44.com/api/apps/69e0f31e9fcd866ea1f3ea35/entities/DiscordRole";
const CHANNELS_URL = "https://app.base44.com/api/apps/69e0f31e9fcd866ea1f3ea35/entities/DiscordChannel";
const API_KEY      = "ffd1652033f74f6f84ae75a8daee1320";

// ============================================================
// FETCH COMMANDS FROM PANEL
// ============================================================
async function fetchCommands() {
  const res = await fetch(API_URL, {
    headers: { "Content-Type": "application/json", "api_key": API_KEY }
  });
  if (!res.ok) {
    console.error("❌ Failed to fetch commands:", res.status, await res.text());
    return [];
  }
  const data = await res.json();
  return data.filter(cmd => cmd.is_enabled !== false);
}

// ============================================================
// FETCH CONFIG FROM PANEL (status, activity, etc.)
// ============================================================
async function fetchConfig() {
  const res = await fetch(CONFIG_URL, {
    headers: { "Content-Type": "application/json", "api_key": API_KEY }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data[0] || null;
}

// ============================================================
// APPLY PRESENCE FROM CONFIG
// ============================================================
const ACTIVITY_TYPES = { playing: 0, streaming: 1, listening: 2, watching: 3, competing: 5 };
async function applyPresence(cfg) {
  if (!cfg) return;
  client.user.setPresence({
    status: cfg.status || "online",
    activities: cfg.activity_text
      ? [{ name: cfg.activity_text, type: ACTIVITY_TYPES[cfg.activity_type] ?? 0 }]
      : []
  });
  console.log(`🎮 Presence updated: ${cfg.status} — ${cfg.activity_type} ${cfg.activity_text}`);
}

// ============================================================
// SYNC GUILD ROLES & CHANNELS TO PANEL DATABASE
// ============================================================
async function syncGuildData() {
  const headers = { "Content-Type": "application/json", "api_key": API_KEY };

  // --- ROLES ---
  try {
    const discordRoles = client.guilds.cache.get(GUILD_ID)?.roles.cache;
    if (discordRoles) {
      const DISCORD_PERMS = {
        2048: "Send Messages", 1024: "Read Messages", 8192: "Manage Messages",
        2: "Kick Members", 4: "Ban Members", 268435456: "Manage Roles",
        16: "Manage Channels", 8: "Administrator", 131072: "Mention Everyone",
        134217728: "Manage Nicknames", 128: "View Audit Log", 536870912: "Manage Webhooks",
      };

      // Clear existing roles in panel
      const existing = await fetch(ROLES_URL, { headers }).then(r => r.json()).catch(() => []);
      await Promise.all(existing.map(r =>
        fetch(`${ROLES_URL}/${r.id}`, { method: "DELETE", headers })
      ));

      // Write current roles
      await Promise.all([...discordRoles.values()].map(role => {
        const permBits = BigInt(role.permissions.bitfield.toString());
        const perms = Object.entries(DISCORD_PERMS)
          .filter(([bit]) => (permBits & BigInt(bit)) !== 0n)
          .map(([, name]) => name);
        const hex = role.color ? `#${role.color.toString(16).padStart(6, "0")}` : "#99AAB5";
        return fetch(ROLES_URL, {
          method: "POST", headers,
          body: JSON.stringify({ discord_id: role.id, name: role.name, color: hex, permissions: perms, hoisted: role.hoist, mentionable: role.mentionable, position: role.position })
        });
      }));
      console.log(`✅ Synced ${discordRoles.size} roles to panel`);
    }
  } catch (e) { console.error("❌ Role sync failed:", e.message); }

  // --- CHANNELS ---
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) {
      const TYPE_MAP = { 0: "text", 2: "voice", 5: "announcement", 10: "text", 11: "forum", 13: "stage" };
      const categories = {};
      guild.channels.cache.filter(c => c.type === 4).forEach(c => { categories[c.id] = c.name; });

      // Clear existing channels in panel
      const existing = await fetch(CHANNELS_URL, { headers }).then(r => r.json()).catch(() => []);
      await Promise.all(existing.map(c =>
        fetch(`${CHANNELS_URL}/${c.id}`, { method: "DELETE", headers })
      ));

      // Write current channels (skip category channels)
      const toSync = guild.channels.cache.filter(c => c.type !== 4);
      await Promise.all([...toSync.values()].map(ch =>
        fetch(CHANNELS_URL, {
          method: "POST", headers,
          body: JSON.stringify({ discord_id: ch.id, name: ch.name, type: TYPE_MAP[ch.type] || "text", category: ch.parentId ? (categories[ch.parentId] || "Uncategorized") : "Uncategorized", topic: ch.topic || "", locked: false, position: ch.position || 0 })
        })
      ));
      console.log(`✅ Synced ${toSync.size} channels to panel`);
    }
  } catch (e) { console.error("❌ Channel sync failed:", e.message); }
}

// ============================================================
// SANITIZE COMMAND NAME (Discord requires: lowercase, letters/numbers/hyphens only, max 32 chars)
// ============================================================
function sanitizeName(name) {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-_]/g, "").slice(0, 32);
}

// ============================================================
// REGISTER SLASH COMMANDS WITH DISCORD
// ============================================================
async function registerSlashCommands(cmds) {
  const rest = new REST().setToken(BOT_TOKEN);
  const slashCmds = cmds
    .filter(cmd => cmd.command_type === "slash" || cmd.command_type === "both")
    .map(cmd => {
      const safeName = sanitizeName(cmd.name);
      console.log(`📝 Registering slash command: /${safeName} (original: "${cmd.name}")`);
      return new SlashCommandBuilder()
        .setName(safeName)
        .setDescription((cmd.description || "No description").slice(0, 100))
        .toJSON();
    });

  try {
    console.log(`⏳ Registering ${slashCmds.length} slash commands with Discord...`);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: slashCmds });
    console.log(`✅ Successfully registered ${slashCmds.length} slash commands!`);
  } catch (err) {
    console.error("❌ Failed to register slash commands:", err.message);
    if (err.rawError) console.error("Discord error details:", JSON.stringify(err.rawError, null, 2));
  }
}

// ============================================================
// PERMISSION CHECK
// ============================================================
function hasPermission(cmd, member, userId) {
  const roleIds = member?.roles?.cache?.map(r => r.id) || [];

  // Blacklist check (always blocks)
  if (cmd.blacklisted_user_ids?.includes(userId)) return false;
  if (cmd.blacklisted_role_ids?.some(id => roleIds.includes(id))) return false;

  // Allowlist check (if empty, everyone is allowed)
  const hasAllowlist = (cmd.allowed_user_ids?.length || 0) + (cmd.allowed_role_ids?.length || 0) > 0;
  if (!hasAllowlist) return true;

  if (cmd.allowed_user_ids?.includes(userId)) return true;
  if (cmd.allowed_role_ids?.some(id => roleIds.includes(id))) return true;

  return false;
}

// ============================================================
// EXECUTE A COMMAND (supports response text + custom code_block)
// ============================================================
async function executeCommand(cmd, { message, interaction, args }) {
  const guild   = message?.guild   || interaction?.guild;
  const channel = message?.channel || interaction?.channel;
  const member  = message?.member  || interaction?.member;
  const user    = message?.author  || interaction?.user;

  // If the command has a custom code_block, run it
  if (cmd.code_block && cmd.code_block.trim()) {
    try {
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      const fn = new AsyncFunction(
        "client", "message", "interaction", "args",
        "guild", "channel", "member", "user",
        "fetch", "djs",
        cmd.code_block
      );
      await fn(
        client, message, interaction, args,
        guild, channel, member, user,
        fetch, djs
      );
    } catch (err) {
      const errMsg = `❌ Error in command **${cmd.name}**: ${err.message}`;
      if (interaction) {
        if (interaction.replied || interaction.deferred) await interaction.followUp({ content: errMsg, ephemeral: true });
        else await interaction.reply({ content: errMsg, ephemeral: true });
      } else if (message) {
        message.reply(errMsg);
      }
      console.error(`❌ code_block error [${cmd.name}]:`, err);
    }
    return;
  }

  // Otherwise just send the response text
  const response = cmd.response || "✅ Command executed!";
  if (interaction) {
    if (interaction.replied || interaction.deferred) await interaction.followUp(response);
    else await interaction.reply(response);
  } else if (message) {
    message.reply(response);
  }
}

// ============================================================
// BOT CLIENT
// ============================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildModeration,
  ]
});

let panelCommands = [];

client.once("ready", async () => {
  console.log(`🤖 ${client.user.tag} is ONLINE!`);
  panelCommands = await fetchCommands();
  await registerSlashCommands(panelCommands);

  // Apply initial presence from panel config
  const initialConfig = await fetchConfig();
  await applyPresence(initialConfig);

  // Sync roles & channels to panel database
  await syncGuildData();

  // Auto-refresh commands + presence from panel every 5 minutes
  // Also re-sync guild data every 30 minutes
  let syncTick = 0;
  setInterval(async () => {
    const [fresh, cfg] = await Promise.all([fetchCommands(), fetchConfig()]);

    // Only re-register slash commands if count changed
    if (fresh.length !== panelCommands.length) {
      await registerSlashCommands(fresh);
    }
    panelCommands = fresh;

    // Always re-apply presence so status/activity changes take effect
    await applyPresence(cfg);

    // Re-sync guild data every 30 minutes (every 6th tick)
    syncTick++;
    if (syncTick % 6 === 0) await syncGuildData();

    console.log(`🔄 Refreshed ${panelCommands.length} commands from panel`);
  }, 5 * 60 * 1000);
});

// ============================================================
// SLASH COMMANDS
// ============================================================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = panelCommands.find(c =>
    sanitizeName(c.name) === interaction.commandName
  );
  if (!cmd) return;
  if (!hasPermission(cmd, interaction.member, interaction.user.id)) {
    return interaction.reply({ content: "❌ You don't have permission to use this command.", ephemeral: true });
  }
  await executeCommand(cmd, { interaction, args: [] });
});

// ============================================================
// PREFIX COMMANDS
// ============================================================
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const parts   = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmdName = parts[0].toLowerCase();
  const args    = parts.slice(1);

  const cmd = panelCommands.find(c =>
    (c.command_type === "prefix" || c.command_type === "both") &&
    sanitizeName(c.name) === cmdName
  );
  if (!cmd) return;
  if (!hasPermission(cmd, message.member, message.author.id)) {
    return message.reply("❌ You don't have permission to use this command.");
  }
  await executeCommand(cmd, { message, args });
});

// ============================================================
// LOGIN
// ============================================================
client.login(BOT_TOKEN);
