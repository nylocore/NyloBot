import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import { fetchTwitterFeed } from '../../services/twitterAnnouncementService.js';

const CONFIG_KEY = (guildId) => `guild:${guildId}:twitterAnnouncements`;
const ACCOUNT = process.env.X_TWITTER_USERNAME || 'nylocore_';

export default {
  data: new SlashCommandBuilder()
    .setName('twitter')
    .setDescription('Configure automatic X/Twitter announcements')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName('setup')
        .setDescription('Send new posts from X to a Discord channel')
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('Channel where new posts should be announced')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('disable')
        .setDescription('Disable automatic X/Twitter announcements'),
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('test')
        .setDescription('Send a test announcement to the configured channel'),
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('Show the current X/Twitter announcement settings'),
    ),

  async execute(interaction, _guildConfig, client) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    }

    const subcommand = interaction.options.getSubcommand();
    const key = CONFIG_KEY(interaction.guildId);
    const config = await client.db.get(key, { enabled: false, channelId: null, postedIds: [] });

    if (subcommand === 'setup') {
      await interaction.deferReply({ ephemeral: true });

      if (!process.env.X_ANNOUNCEMENT_RSS_URL) {
        return interaction.editReply(
          'The RSS feed is not configured yet. Add `X_ANNOUNCEMENT_RSS_URL` to your bot environment, then restart NyloBot.',
        );
      }

      const channel = interaction.options.getChannel('channel', true);
      if (!channel.isTextBased() || !channel.send) {
        return interaction.editReply('Please choose a text or announcement channel.');
      }

      try {
        const latestItems = await fetchTwitterFeed();
        if (latestItems.length === 0) {
          return interaction.editReply('I could not find any posts in that RSS feed. Check the feed URL and try again.');
        }

        // Seed existing posts so setup does not flood the channel with old tweets.
        await client.db.set(key, {
          enabled: true,
          channelId: channel.id,
          postedIds: latestItems.map(item => item.id).slice(-150),
          configuredBy: interaction.user.id,
          configuredAt: new Date().toISOString(),
          lastPostedAt: null,
        });

        return interaction.editReply(
          `X announcements are enabled in ${channel} for **@${ACCOUNT}**. New posts will be checked about every two minutes. Existing feed items will not be reposted.`,
        );
      } catch (error) {
        return interaction.editReply(`I couldn't read the RSS feed: ${error.message}`);
      }
    }

    if (subcommand === 'disable') {
      await client.db.set(key, { ...config, enabled: false });
      return interaction.reply({ content: 'X announcements have been disabled for this server.', ephemeral: true });
    }

    if (subcommand === 'status') {
      const channel = config.channelId ? `<#${config.channelId}>` : 'Not configured';
      return interaction.reply({
        content: `**X announcements:** ${config.enabled ? 'Enabled' : 'Disabled'}\n**Account:** @${ACCOUNT}\n**Channel:** ${channel}\n**Last announcement:** ${config.lastPostedAt ? `<t:${Math.floor(new Date(config.lastPostedAt).getTime() / 1000)}:R>` : 'None yet'}`,
        ephemeral: true,
      });
    }

    if (subcommand === 'test') {
      if (!config.enabled || !config.channelId) {
        return interaction.reply({ content: 'Run `/twitter setup` first.', ephemeral: true });
      }

      const channel = await interaction.guild.channels.fetch(config.channelId).catch(() => null);
      if (!channel?.send) {
        return interaction.reply({ content: 'The configured announcement channel is unavailable. Run `/twitter setup` again.', ephemeral: true });
      }

      await channel.send({
        embeds: [{
          color: 0x1D9BF0,
          author: { name: `New post from @${ACCOUNT}`, url: 'https://x.com/nylocore_' },
          description: 'This is a test announcement. New posts from your X feed will appear here.',
          url: 'https://x.com/nylocore_',
          footer: { text: 'X / Twitter • NyloBot test' },
          timestamp: new Date().toISOString(),
        }],
        allowedMentions: { parse: [] },
      });

      return interaction.reply({ content: `Test announcement sent to <#${config.channelId}>.`, ephemeral: true });
    }
  },
};
