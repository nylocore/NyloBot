import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';

const CONFIG_KEY = (guildId) => `guild:${guildId}:twitterAnnouncements`;
const MAX_POSTED_IDS = 150;
const MAX_ANNOUNCEMENTS_PER_CHECK = 10;

function decodeXml(value = '') {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function getTag(block, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}\\s*>`, 'i'));
  return match ? decodeXml(match[1]).trim() : '';
}

function getAttribute(block, tagName, attribute) {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = block.match(new RegExp(`<${escapedTag}\\b[^>]*>`, 'i'))?.[0] || '';
  const escapedAttribute = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`${escapedAttribute}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

function stripHtml(value = '') {
  return decodeXml(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stableId(item) {
  const explicit = getTag(item, 'guid') || getTag(item, 'id');
  const link = getTag(item, 'link') || getAttribute(item, 'link', 'href');
  const date = getTag(item, 'pubDate') || getTag(item, 'published') || getTag(item, 'updated');
  const title = getTag(item, 'title');
  return explicit || link || createHash('sha1').update(`${title}|${date}`).digest('hex');
}

function parseItem(item) {
  const link = getTag(item, 'link') || getAttribute(item, 'link', 'href') ||
    getAttribute(item, 'atom:link', 'href');
  const rawText = getTag(item, 'description') ||
    getTag(item, 'content:encoded') ||
    getTag(item, 'content') ||
    getTag(item, 'summary') ||
    getTag(item, 'title');

  const image =
    getAttribute(item, 'media:content', 'url') ||
    getAttribute(item, 'media:thumbnail', 'url') ||
    getAttribute(item, 'enclosure', 'url') ||
    item.match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1] ||
    null;

  const published = getTag(item, 'pubDate') || getTag(item, 'published') ||
    getTag(item, 'updated') || getTag(item, 'dc:date');

  return {
    id: stableId(item),
    text: stripHtml(rawText).slice(0, 3900),
    url: link,
    image: image ? decodeXml(image) : null,
    publishedAt: published ? new Date(published) : new Date(0),
  };
}

export async function fetchTwitterFeed(feedUrl = process.env.X_ANNOUNCEMENT_RSS_URL) {
  if (!feedUrl) {
    throw new Error('X_ANNOUNCEMENT_RSS_URL is not configured.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(feedUrl);
  } catch {
    throw new Error('X_ANNOUNCEMENT_RSS_URL must be a valid HTTP(S) URL.');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('The RSS feed URL must use HTTP or HTTPS.');
  }

  const response = await fetch(parsedUrl, {
    headers: {
      'User-Agent': 'NyloBot-TwitterAnnouncements/1.0',
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`RSS provider returned HTTP ${response.status}.`);
  }

  const xml = await response.text();
  const blocks = [
    ...xml.matchAll(/<item\b[^>]*>[\s\S]*?<\/item\s*>/gi),
    ...xml.matchAll(/<entry\b[^>]*>[\s\S]*?<\/entry\s*>/gi),
  ].map(match => match[0]);

  const unique = new Map();
  for (const block of blocks) {
    const item = parseItem(block);
    if (item.id && item.text) unique.set(item.id, item);
  }

  return [...unique.values()].sort((a, b) => a.publishedAt - b.publishedAt);
}

export async function checkTwitterAnnouncements(client) {
  if (!client?.db || !client.guilds?.cache) return;

  for (const [guildId, guild] of client.guilds.cache) {
    try {
      const key = CONFIG_KEY(guildId);
      const config = await client.db.get(key, null);
      if (!config?.enabled || !config.channelId) continue;

      const channel = await guild.channels.fetch(config.channelId).catch(() => null);
      if (!channel?.isTextBased?.() || !channel.send) {
        logger.warn(`Twitter announcements: channel unavailable for guild ${guildId}`);
        continue;
      }

      const items = await fetchTwitterFeed();
      const posted = new Set(config.postedIds || []);
      const fresh = items.filter(item => !posted.has(item.id)).slice(-MAX_ANNOUNCEMENTS_PER_CHECK);

      for (const item of fresh) {
        const embed = {
          color: 0x1D9BF0,
          author: {
            name: `New post from @${process.env.X_TWITTER_USERNAME || 'nylocore_'}`,
            url: 'https://x.com/nylocore_',
          },
          description: item.text || 'A new post was published.',
          url: item.url || 'https://x.com/nylocore_',
          timestamp: Number.isNaN(item.publishedAt.getTime()) || item.publishedAt.getTime() === 0
            ? new Date().toISOString()
            : item.publishedAt.toISOString(),
          footer: { text: 'X / Twitter' },
        };

        if (item.image && /^https?:\/\//i.test(item.image)) {
          embed.image = { url: item.image };
        }

        if (item.url && /^https?:\/\//i.test(item.url)) {
          embed.description = `${embed.description}\n\n[View post on X](${item.url})`.slice(0, 4096);
        }

        await channel.send({
          embeds: [embed],
          allowedMentions: { parse: [] },
        });

        posted.add(item.id);
        config.postedIds = [...posted].slice(-MAX_POSTED_IDS);
        config.lastPostedAt = new Date().toISOString();
        await client.db.set(key, config);
      }
    } catch (error) {
      logger.error(`Twitter announcement check failed for guild ${guildId}:`, error);
    }
  }
}
