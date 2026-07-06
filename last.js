// ========================================
// 基本設定
// ========================================
const clientId = "18a7af28818a40abafa707e98e4d7a48";
const redirectUri = "https://pengoffline.github.io/entropic-spotify/last.html";

// 需要讀取個人資料 + 短/中/長期最常聽曲目
const scope = "user-read-private user-top-read";

const LASTFM_API_KEY = "ae2cc018d4f250ba07c42af81da93d95";
const LASTFM_BASE_URL = "https://ws.audioscrobbler.com/2.0/";

const TOP_TRACKS_LIMIT = 50;

// 表情符號判斷門檻
const FAME_LISTENERS_THRESHOLD = 500000;  // 📀 聽眾 > 500,000
const RARE_LISTENERS_THRESHOLD = 1000;    // 🧊 聽眾 < 1,000
const HOT_REPLAY_THRESHOLD = 10;          // 🔥 平均重播 > 10

const trackInfoCache = {}; // "artist|||track" -> { listeners, playcount, tags: [{name, count}], fromFallback }

let currentToken = null;

// ========================================
// PKCE 工具函式(與原本 Spotify 專案相同)
// ========================================
function generateRandomString(length) {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

async function generateCodeChallenge(codeVerifier) {
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// ========================================
// 登入按鈕:導向 Spotify 授權頁
// ========================================
document.getElementById("login-btn")?.addEventListener("click", async () => {
  const codeVerifier = generateRandomString(64);
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  localStorage.setItem("code_verifier", codeVerifier);

  const authUrl = new URL("https://accounts.spotify.com/authorize");
  const params = {
    response_type: "code",
    client_id: clientId,
    scope,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
    redirect_uri: redirectUri,
  };
  authUrl.search = new URLSearchParams(params).toString();
  window.location.href = authUrl.toString();
});

// ========================================
// 頁面載入時:處理授權回跳 或 已登入狀態
// ========================================
window.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");

  if (code) {
    const codeVerifier = localStorage.getItem("code_verifier");

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    });

    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const data = await response.json();

    if (data.access_token) {
      localStorage.setItem("access_token", data.access_token);
      window.history.replaceState({}, document.title, redirectUri);
      await runAll(data.access_token);
    } else {
      console.error("換取 token 失敗", data);
    }
  } else if (localStorage.getItem("access_token")) {
    await runAll(localStorage.getItem("access_token"));
  }
});

async function runAll(token) {
  currentToken = token;
  try {
    await fetchProfile(token);
    setupRangeButtons();
    await fetchTopTracksAndEnrich(token, "medium_term"); // 預設顯示「這半年」
  } catch (err) {
    console.error(err);
    alert(`發生錯誤:${err.message}`);
  }
}

// ========================================
// 時間範圍按鈕(這個月 / 這半年 / 這一年)
// ========================================
function setupRangeButtons() {
  const buttons = document.querySelectorAll(".range-btn");
  buttons.forEach(btn => {
    btn.addEventListener("click", () => {
      buttons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      fetchTopTracksAndEnrich(currentToken, btn.dataset.range);
    });
    if (btn.dataset.range === "medium_term") {
      btn.classList.add("active");
    }
  });
}

// ========================================
// 抓取使用者個人資料
// ========================================
async function fetchProfile(token) {
  const res = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    console.error("抓取使用者資料失敗", res.status);
    localStorage.removeItem("access_token");
    return;
  }

  const profile = await res.json();

  document.getElementById("login-view").style.display = "none";
  document.getElementById("profile-view").style.display = "flex";
  document.getElementById("display-name-title").textContent = `你好, ${profile.display_name}`;
  if (profile.images?.[0]) {
    document.getElementById("avatar").src = profile.images[0].url;
  }
}

// ========================================
// 抓取「最常聽」50 首曲目(依時間範圍),逐首串接 Last.fm 補上 listeners / scrobbles / 標籤
// ========================================
async function fetchTopTracksAndEnrich(token, timeRange) {
  document.getElementById("global-loading").style.display = "block";
  document.getElementById("history-view").style.display = "block";

  const container = document.getElementById("track-list");
  container.innerHTML = "<p style='color:#999;'>載入中,正在查詢 Spotify 最常聽曲目...</p>";

  const res = await fetch(
    `https://api.spotify.com/v1/me/top/tracks?time_range=${timeRange}&limit=${TOP_TRACKS_LIMIT}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    console.error("抓取最常聽曲目失敗", res.status);
    container.innerHTML = "<p style='color:#f66;'>抓取資料失敗,請稍後再試。</p>";
    document.getElementById("global-loading").style.display = "none";
    return;
  }

  const data = await res.json();
  const tracks = data.items || [];

  const enrichedTracks = [];
  const tagWeights = {};         // 標籤名稱 -> 累積權重(用於文字雲字級大小)
  const tagAppearanceCount = {}; // 標籤名稱 -> 出現在幾首歌裡(用於 Top5 清單)

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const artistName = track.artists[0].name;
    const trackName = track.name;

    container.innerHTML = `<p style='color:#999;'>查詢中... (${i + 1}/${tracks.length})</p>`;

    const info = await fetchLastfmTrackInfo(artistName, trackName);

    const avgReplayPerListener =
      info.listeners && info.playcount && info.listeners > 0
        ? info.playcount / info.listeners
        : null;

    const uniqueTagNames = [...new Set(info.tags.map(t => t.name))];

    info.tags.forEach(tag => {
      const weight = tag.count || 1; // Last.fm 回傳的 count 是 0~100 的相對權重,用於文字雲大小
      tagWeights[tag.name] = (tagWeights[tag.name] || 0) + weight;
    });

    uniqueTagNames.forEach(tagName => {
      tagAppearanceCount[tagName] = (tagAppearanceCount[tagName] || 0) + 1; // 出現次數:1首歌同個標籤只算1次
    });

    enrichedTracks.push({
      rank: i + 1,
      artist: artistName,
      name: trackName,
      image: track.album.images?.[2]?.url || track.album.images?.[0]?.url,
      listeners: info.listeners,
      playcount: info.playcount,
      avgReplayPerListener,
      tags: uniqueTagNames,
      tagsFromFallback: info.fromFallback,
    });
  }

  renderTrackList(enrichedTracks);
  renderQuickStats(enrichedTracks);
  renderWordCloud(tagWeights);
  renderTopTagsList(tagAppearanceCount);

  document.getElementById("global-loading").style.display = "none";
}

// ========================================
// 清理 Spotify 曲名裡常見、會讓 Last.fm 比對失敗的後綴
// 例如:"Song (feat. Someone)"、"Song - 2011 Remaster"、"Song (Live)" 等
// 只在第一次查詢查無標籤時才會用清理過的名稱重試,不影響原本的曲名顯示
// ========================================
function cleanTrackName(name) {
  return name
    .replace(/\s*\(feat\.?[^)]*\)/i, "")
    .replace(/\s*\[feat\.?[^\]]*\]/i, "")
    .replace(/\s*\(with\s+[^)]*\)/i, "")
    .replace(/\s*-\s*(remaster(ed)?(\s*\d{4})?|live.*|radio edit|single version|bonus track|mono version|stereo version|deluxe.*|explicit|clean|\d{4}\s*mix)\s*$/i, "")
    .replace(/\s*\((remaster(ed)?[^)]*|live[^)]*|radio edit|single version|bonus track|mono[^)]*|stereo[^)]*|deluxe[^)]*|explicit|clean)\)\s*$/i, "")
    .trim();
}

// ========================================
// 查詢單一曲目在 Last.fm 的資訊:listeners / scrobbles(playcount) / 標籤
// 查詢順序:
//   1) 用 Spotify 原始曲名查 track.getInfo
//   2) 若查無標籤,清理曲名(拿掉 feat./remaster 等後綴)後重試
//   3) 若還是查無標籤,退回抓「歌手」的熱門標籤當備援(標記 fromFallback)
// 同一首歌(同歌手+同曲名)只查一次,結果共用快取
// ========================================
async function fetchLastfmTrackInfo(artistName, trackName) {
  const cacheKey = `${artistName.toLowerCase()}|||${trackName.toLowerCase()}`;
  if (trackInfoCache[cacheKey]) {
    return trackInfoCache[cacheKey];
  }

  let result = { listeners: null, playcount: null, tags: [], fromFallback: false };

  // 1) 原始曲名
  const first = await lastfmTrackGetInfo(artistName, trackName);
  result.listeners = first.listeners;
  result.playcount = first.playcount;
  result.tags = first.tags;

  // 2) 若查無標籤,試試清理過的曲名
  if (result.tags.length === 0) {
    const cleanedName = cleanTrackName(trackName);
    if (cleanedName && cleanedName.toLowerCase() !== trackName.toLowerCase()) {
      const second = await lastfmTrackGetInfo(artistName, cleanedName);
      if (second.tags.length > 0) {
        result.tags = second.tags;
      }
      if (result.listeners === null) result.listeners = second.listeners;
      if (result.playcount === null) result.playcount = second.playcount;
    }
  }

  // 3) 還是查無標籤,退回歌手的熱門標籤當備援
  if (result.tags.length === 0) {
    const artistTags = await lastfmArtistGetTopTags(artistName);
    if (artistTags.length > 0) {
      result.tags = artistTags;
      result.fromFallback = true;
    }
  }

  trackInfoCache[cacheKey] = result;
  return result;
}

async function lastfmTrackGetInfo(artistName, trackName) {
  let result = { listeners: null, playcount: null, tags: [] };
  try {
    const url = new URL(LASTFM_BASE_URL);
    url.searchParams.set("method", "track.getInfo");
    url.searchParams.set("api_key", LASTFM_API_KEY);
    url.searchParams.set("artist", artistName);
    url.searchParams.set("track", trackName);
    url.searchParams.set("autocorrect", "1");
    url.searchParams.set("format", "json");

    const res = await fetch(url.toString());
    const data = await res.json();

    if (!data.error && data.track) {
      result.listeners = data.track.listeners ? Number(data.track.listeners) : null;
      result.playcount = data.track.playcount ? Number(data.track.playcount) : null;
      result.tags = (data.track.toptags?.tag || [])
        .map(t => ({ name: t.name, count: Number(t.count) || 1 }))
        .filter(t => t.count > 0);
    }
  } catch (err) {
    console.warn(`Last.fm track.getInfo 查詢失敗: ${artistName} - ${trackName}`, err.message);
  }
  return result;
}

async function lastfmArtistGetTopTags(artistName) {
  try {
    const url = new URL(LASTFM_BASE_URL);
    url.searchParams.set("method", "artist.getTopTags");
    url.searchParams.set("api_key", LASTFM_API_KEY);
    url.searchParams.set("artist", artistName);
    url.searchParams.set("autocorrect", "1");
    url.searchParams.set("format", "json");

    const res = await fetch(url.toString());
    const data = await res.json();

    if (!data.error && data.toptags?.tag) {
      return data.toptags.tag
        .map(t => ({ name: t.name, count: Number(t.count) || 1 }))
        .filter(t => t.count > 0)
        .slice(0, 5);
    }
  } catch (err) {
    console.warn(`Last.fm artist.getTopTags 查詢失敗: ${artistName}`, err.message);
  }
  return [];
}

// ========================================
// 依門檻回傳表情符號前綴(可能同時符合多個條件時,依序疊加)
// ========================================
function getListenersEmoji(listeners) {
  if (typeof listeners !== "number") return "";
  if (listeners > FAME_LISTENERS_THRESHOLD) return "📀 ";
  if (listeners < RARE_LISTENERS_THRESHOLD) return "🧊 ";
  return "";
}

function getReplayEmoji(avgReplay) {
  if (typeof avgReplay !== "number") return "";
  if (avgReplay > HOT_REPLAY_THRESHOLD) return "🔥 ";
  return "";
}

// ========================================
// 顯示歌單清單(含 listeners / scrobbles / 平均重播次數 / 標籤 / 表情符號)
// ========================================
function renderTrackList(enrichedTracks) {
  const container = document.getElementById("track-list");
  container.innerHTML = "";

  enrichedTracks.forEach(({ rank, artist, name, image, listeners, playcount, avgReplayPerListener, tags, tagsFromFallback }) => {
    const listenersEmoji = getListenersEmoji(listeners);
    const replayEmoji = getReplayEmoji(avgReplayPerListener);

    const listenersText = listeners !== null ? `${listenersEmoji}${listeners.toLocaleString()}` : "無資料";
    const playcountText = playcount !== null ? playcount.toLocaleString() : "無資料";
    const replayText = avgReplayPerListener !== null ? `${replayEmoji}${avgReplayPerListener.toFixed(1)}` : "—";
    const fallbackNote = tagsFromFallback ? `<span class="fallback-note">(曲目查無標籤,顯示歌手標籤)</span>` : "";
    const tagsHtml = tags.length > 0
      ? tags.slice(0, 5).map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("") + fallbackNote
      : `<span class="tag-chip">無標籤</span>`;

    const item = document.createElement("div");
    item.className = "track-item";
    item.innerHTML = `
      <img src="${image || ''}" width="60" height="60" onerror="this.style.visibility='hidden'">
      <div>
        <strong>#${rank} ${escapeHtml(name)}</strong> - ${escapeHtml(artist)}<br>
        <span class="track-stats">
          聽眾 ${listenersText} ｜ 播放 ${playcountText}
          <span class="replay-badge">平均重播 ${replayText} 次</span>
        </span><br>
        ${tagsHtml}
      </div>
    `;
    container.appendChild(item);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ========================================
// 歌曲概況統計:
// 平均聽眾數 / 平均重播數 / 最多人聽過 / 最稀有歌曲 / 大家最愛聽 / 你的私藏曲
// ========================================
function renderQuickStats(enrichedTracks) {
  const withData = enrichedTracks.filter(t => t.listeners && t.playcount);

  const avgListeners = withData.length > 0
    ? Math.round(withData.reduce((sum, t) => sum + t.listeners, 0) / withData.length)
    : null;
  const avgReplay = withData.length > 0
    ? (withData.reduce((sum, t) => sum + t.avgReplayPerListener, 0) / withData.length).toFixed(1)
    : null;

  const mostPopular = withData.reduce((max, t) =>
    (!max || t.listeners > max.listeners) ? t : max, null);

  const mostRare = withData.reduce((min, t) =>
    (!min || t.listeners < min.listeners) ? t : min, null);

  const mostReplayed = withData.reduce((max, t) =>
    (!max || t.avgReplayPerListener > max.avgReplayPerListener) ? t : max, null);

  const leastReplayed = withData.reduce((min, t) =>
    (!min || t.avgReplayPerListener < min.avgReplayPerListener) ? t : min, null);

  document.getElementById("quick-stats-view").style.display = "block";
  document.getElementById("quick-stats").innerHTML = `
    <div class="quick-stat-item"><span class="quick-stat-label">平均聽眾數</span><span class="quick-stat-value">${avgListeners !== null ? avgListeners.toLocaleString() : "—"}</span></div>
    <div class="quick-stat-item"><span class="quick-stat-label">平均重播數</span><span class="quick-stat-value">${avgReplay ?? "—"}</span></div>
    <div class="quick-stat-item"><span class="quick-stat-label">最多人聽過</span><span class="quick-stat-value" style="font-size:13px;">${mostPopular ? escapeHtml(mostPopular.name) : "—"}</span></div>
    <div class="quick-stat-item"><span class="quick-stat-label">最稀有歌曲</span><span class="quick-stat-value" style="font-size:13px;">${mostRare ? escapeHtml(mostRare.name) : "—"}</span></div>
    <div class="quick-stat-item"><span class="quick-stat-label">大家最愛聽</span><span class="quick-stat-value" style="font-size:13px;">${mostReplayed ? escapeHtml(mostReplayed.name) : "—"}</span></div>
    <div class="quick-stat-item"><span class="quick-stat-label">你的私藏曲</span><span class="quick-stat-value" style="font-size:13px;">${leastReplayed ? escapeHtml(leastReplayed.name) : "—"}</span></div>
  `;
}

// ========================================
// Top 5 標籤清單(依「出現在幾首歌裡」排序,不是文字雲用的權重)
// ========================================
function renderTopTagsList(tagAppearanceCount) {
  const container = document.getElementById("top-tags-list");
  if (!container) return;

  const sorted = Object.entries(tagAppearanceCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (sorted.length === 0) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = sorted.map(([tag, count], i) => `
    <span class="top-tag-item"><span class="rank">#${i + 1}</span>${escapeHtml(tag)}<span class="count">× ${count}</span></span>
  `).join("");
}

// ========================================
// 標籤文字雲(用 wordcloud2.js 畫在 canvas 上)
// ========================================
function renderWordCloud(tagWeights) {
  const entries = Object.entries(tagWeights);
  if (entries.length === 0) return;

  document.getElementById("wordcloud-view").style.display = "block";

  const canvas = document.getElementById("wordcloud-canvas");
  const dpr = window.devicePixelRatio || 1;
  const displayWidth = canvas.clientWidth || 900;
  const displayHeight = 420;

  canvas.width = displayWidth * dpr;
  canvas.height = displayHeight * dpr;
  canvas.style.width = displayWidth + "px";
  canvas.style.height = displayHeight + "px";

  const sortedEntries = entries.sort((a, b) => b[1] - a[1]).slice(0, 50);
  const weights = sortedEntries.map(([, w]) => w);
  const maxW = Math.max(...weights);
  const minW = Math.min(...weights);

  const MIN_FONT = 16 * dpr;
  const MAX_FONT = 100 * dpr;

  const list = sortedEntries.map(([name, w]) => {
    const norm = maxW === minW ? 1 : (w - minW) / (maxW - minW);
    const fontSize = MIN_FONT + norm * (MAX_FONT - MIN_FONT);
    return [name, fontSize];
  });

  const colors = ["#1DB954", "#d51007", "#ffffff", "#1ed760", "#ff6b5b", "#cccccc"];

  WordCloud(canvas, {
    list,
    weightFactor: (size) => size,
    fontFamily: "Helvetica Neue, Arial, sans-serif",
    fontWeight: "bold",
    color: () => colors[Math.floor(Math.random() * colors.length)],
    backgroundColor: "transparent",
    gridSize: Math.round(6 * dpr),
    rotateRatio: 0.25,
    rotationSteps: 2,
    shrinkToFit: true,
    drawOutOfBound: false,
  });
}
