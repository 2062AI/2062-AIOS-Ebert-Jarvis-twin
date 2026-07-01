// youtube.js — read-only YouTube Data API v3 tool (Season 4 content mission).
//
// Pulls the owner's PUBLIC channel data — stats, recent uploads, per-video
// metrics, and comments — so Jarvis can help manage @YourChannel without anyone
// pasting data by hand. Read-only: it never posts, comments, or edits anything.
//
// Setup (one time):
//   1. console.cloud.google.com → create/select a project.
//   2. APIs & Services → Library → enable "YouTube Data API v3".
//   3. Credentials → Create credentials → API key. Restrict it to the
//      YouTube Data API v3.
//   4. Put it in .env as YOUTUBE_API_KEY=... and set YOUTUBE_CHANNEL=@YourChannel.
//
// A plain API key only reads public data (no OAuth, no account access).

const API_KEY = process.env.YOUTUBE_API_KEY || "";
const CHANNEL = process.env.YOUTUBE_CHANNEL || "@YourChannel";
const BASE = "https://www.googleapis.com/youtube/v3";

function configured() {
  return !!API_KEY;
}

// Low-level GET against the Data API. Throws a clean error on failure.
async function api(path, params = {}) {
  if (!configured()) {
    throw new Error(
      "YouTube not configured. Set YOUTUBE_API_KEY (and YOUTUBE_CHANNEL) in .env — " +
        "see the setup steps at the top of src/youtube.js."
    );
  }
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  url.searchParams.set("key", API_KEY);

  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    const msg = data && data.error ? data.error.message : `HTTP ${res.status}`;
    throw new Error(`YouTube API: ${msg}`);
  }
  return data;
}

// A channel ID looks like "UC" + 22 chars. Otherwise treat as an @handle.
function isChannelId(s) {
  return /^UC[\w-]{22}$/.test(s);
}

// Resolve the configured channel to id + stats + the uploads playlist id.
async function getChannel(channel = CHANNEL) {
  const params = { part: "snippet,statistics,contentDetails" };
  if (isChannelId(channel)) params.id = channel;
  else params.forHandle = channel.replace(/^@/, "");

  const data = await api("channels", params);
  const c = data.items && data.items[0];
  if (!c) throw new Error(`Channel not found: ${channel}`);
  return {
    id: c.id,
    title: c.snippet.title,
    description: c.snippet.description,
    subscribers: Number(c.statistics.subscriberCount || 0),
    views: Number(c.statistics.viewCount || 0),
    videoCount: Number(c.statistics.videoCount || 0),
    uploadsPlaylist: c.contentDetails.relatedPlaylists.uploads,
  };
}

// Most recent uploads (title, id, publishedAt), newest first.
async function recentVideos(limit = 10, channel = CHANNEL) {
  const ch = await getChannel(channel);
  const data = await api("playlistItems", {
    part: "snippet,contentDetails",
    playlistId: ch.uploadsPlaylist,
    maxResults: Math.min(Math.max(limit, 1), 50),
  });
  return (data.items || []).map((it) => ({
    videoId: it.contentDetails.videoId,
    title: it.snippet.title,
    publishedAt: it.contentDetails.videoPublishedAt || it.snippet.publishedAt,
  }));
}

// Per-video statistics + description for a set of video ids.
async function videoStats(ids = []) {
  if (!ids.length) return [];
  const data = await api("videos", {
    part: "snippet,statistics",
    id: ids.slice(0, 50).join(","),
  });
  return (data.items || []).map((v) => ({
    videoId: v.id,
    title: v.snippet.title,
    description: v.snippet.description,
    publishedAt: v.snippet.publishedAt,
    views: Number(v.statistics.viewCount || 0),
    likes: Number(v.statistics.likeCount || 0),
    comments: Number(v.statistics.commentCount || 0),
  }));
}

// Top-level comments on a video (most relevant first).
async function videoComments(videoId, limit = 10) {
  const data = await api("commentThreads", {
    part: "snippet",
    videoId,
    maxResults: Math.min(Math.max(limit, 1), 100),
    order: "relevance",
    textFormat: "plainText",
  });
  return (data.items || []).map((t) => {
    const c = t.snippet.topLevelComment.snippet;
    return {
      author: c.authorDisplayName,
      text: c.textDisplay,
      likes: Number(c.likeCount || 0),
      publishedAt: c.publishedAt,
    };
  });
}

// Combined channel overview: stats + recent uploads with their metrics.
async function channelSummary({ videoLimit = 5, channel = CHANNEL } = {}) {
  const ch = await getChannel(channel);
  const recent = await recentVideos(videoLimit, channel);
  const stats = await videoStats(recent.map((v) => v.videoId));
  // Preserve recency order (videoStats may reorder), merge metrics in.
  const byId = Object.fromEntries(stats.map((s) => [s.videoId, s]));
  const videos = recent.map((v) => ({ ...v, ...(byId[v.videoId] || {}) }));
  return { channel: ch, videos };
}

// --- chat integration ----------------------------------------------------
// Inject live channel data into Ebert's chat context, but only when the message
// is actually about the channel (saves API quota + latency), and cache the
// summary so rapid back-and-forth doesn't re-hit the API every turn.

const CACHE_MS = parseInt(process.env.YOUTUBE_CACHE_MS || "300000", 10); // 5 min
let _cache = { at: 0, block: "" };

// Does this message look like it's about the YouTube channel?
function isRelevant(text) {
  if (!text || typeof text !== "string") return false;
  return /\b(youtube|yt|channel|subscribers?|sub count|views?|videos?|uploads?|thumbnail|comments?|watch time|analytics|@?brownin ?ai)\b/i.test(
    text
  );
}

const _num = (x) => Number(x || 0).toLocaleString();

// Formatted live channel block for the system prompt. Public data only —
// channel stats + recent video titles/metrics (no comment bodies, to avoid
// pulling untrusted text into the prompt). Fail-soft: returns "" on any error.
async function contextBlock({ videoLimit = 6 } = {}) {
  if (!configured()) return "";
  const now = Date.now();
  if (_cache.block && now - _cache.at < CACHE_MS) return _cache.block;
  try {
    const { channel, videos } = await channelSummary({ videoLimit });
    const lines = videos.map(
      (v) =>
        `- "${v.title}" — ${_num(v.views)} views, ${_num(v.likes)} likes, ` +
        `${_num(v.comments)} comments (${(v.publishedAt || "").slice(0, 10)}, id ${v.videoId})`
    );
    const block =
      `=== YOUTUBE CHANNEL (live public data) ===\n` +
      `Channel: ${channel.title} (${CHANNEL})\n` +
      `Subscribers: ${_num(channel.subscribers)} · Total views: ${_num(channel.views)} · ` +
      `Videos: ${_num(channel.videoCount)}\n` +
      `Recent uploads (newest first):\n${lines.join("\n")}\n` +
      `=== END YOUTUBE CHANNEL ===`;
    _cache = { at: now, block };
    return block;
  } catch (e) {
    console.error("[youtube] contextBlock:", e.message);
    return "";
  }
}

module.exports = {
  configured,
  getChannel,
  recentVideos,
  videoStats,
  videoComments,
  channelSummary,
  isRelevant,
  contextBlock,
  CHANNEL,
};
