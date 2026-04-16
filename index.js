// ============================================================
// BotForge Bot - index.js
// Auto-loads ALL commands + custom code from your panel
// ============================================================

const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder } = require("discord.js");

const BOT_TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Your bot's Application ID
const GUILD_ID  = "1481739027488182354";
const PREFIX    = "!fix";

const API_URL = "https://app.base44.com/api/apps/69e0f31e9fcd866ea1f3ea35/entities/BotCommand";
const API_KEY  = "ffd1652033f74f6f84ae75a8daee1320";

// ============================================================
// FETCH COMMANDS FROM PANEL
// ============================================================
async function fetchCommands() {
  const res = await fetch(API_URL, {
    headers: {
      "Content-Type": "application/json",
      "api_key": API_KEY
    }
  });
  if (!res.ok) {
    console.error("❌ Failed to fetch commands:", res.status, await res.text());
    return [];
  }
  const data = await res.json();
  return data.filter(cmd => cmd.is_enabled !== false);
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
        "fetch", "EmbedBuilder",
        cmd.code_block
      );
      await fn(
        client, message, interaction, args,
        guild, channel, member, user,
        fetch, EmbedBuilder
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

  client.user.setPresence({
    status: "dnd",
    activities: [{ name: "!corehelp", type: 0 }]
  });

  // Auto-refresh commands from panel every 5 minutes
  setInterval(async () => {
    const fresh = await fetchCommands();
    // Only re-register if command count changed
    if (fresh.length !== panelCommands.length) {
      await registerSlashCommands(fresh);
    }
    panelCommands = fresh;
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
