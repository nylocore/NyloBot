
import { ChannelType } from 'discord.js';

export async function updateVoiceCounter(client) {
    const guild = await client.guilds.fetch(
        process.env.GUILD_ID
    );

    const counterChannel = await guild.channels.fetch(
        process.env.VOICE_COUNTER_CHANNEL_ID
    );

    if (!counterChannel) return;

    const voiceMembers = guild.channels.cache
        .filter(channel =>
            channel.type === ChannelType.GuildVoice &&
            channel.id !== counterChannel.id
        )
        .reduce((total, channel) => {
            return total + channel.members.filter(
                member => !member.user.bot
            ).size;
        }, 0);

    const newName = `🔊・Members in VC: ${voiceMembers}`;

    if (counterChannel.name !== newName) {
        await counterChannel.setName(newName);
    }
}
