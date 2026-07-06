// ========================================
// 基本設定
// ========================================
const clientId = "18a7af28818a40abafa707e98e4d7a48";
// ⚠️ 這個頁面的網址跟原本 Spotify 專案不同,記得:
// 1. 把下面這行換成這個頁面實際發布後的 GitHub Pages 網址
// 2. 到 Spotify Developer Dashboard 的 App 設定裡,把這個網址加進 Redirect URIs 清單
const redirectUri = "https://pengoffline.github.io/entropic-spotify/last.html";

const scope = "user-read-private user-read-recently-played";

const LASTFM_API_KEY = "ae2cc018d4f250ba07c42af81da93d95";
const LASTFM_BASE_URL = "https://ws.audioscrobbler.com/2.0/";

const RECENT_TRACKS_LIMIT = 50;

const trackInfoCache = {}; // "artist|||track" -> { listeners, playcount, tags: [{name, count}] }

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
  try {
    await fetchProfile(token);
    await fetchRecentlyPlayedAndEnrich(token);
  } catch (err) {
    console.error(err);
    alert(`發生錯誤:${err.message}`);
  }
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
// 抓取最近 50 首播放紀錄,逐首串接 Last.fm 補上 listeners / scrobbles / 標籤
// ========================================
async function fetchRecentlyPlayedAndEnrich(token) {
  document.getElementById("global-loading").style.display = "block";
  document.getElementById("history-view").style.display = "block";

  const container = document.getElementById("track-list");
  container.innerHTML = "<p style='color:#999;'>載入中,正在查詢 Spotify 聆聽紀錄...</p>";

  const res = await fetch(
    `https://api.spotify.com/v1/me/player/recently-played?limit=${RECENT_TRACKS_LIMIT}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    console.error("抓取聆聽紀錄失敗", res.status);
    container.innerHTML = "<p style='color:#f66;'>抓取聆聽紀錄失敗,請稍後再試。</p>";
    document.getElementById("global-loading").style.display = "none";
    return;
  }

  const data = await res.json();
  const items = data.items || [];

  const enrichedTracks = [];
  const tagWeights = {}; // 標籤名稱 -> 累積權重(用於文字雲)

  for (let i = 0; i < items.length; i++) {
    const { track, played_at } = items[i];
    const artistName = track.artists[0].name;
    const trackName = track.name;

    container.innerHTML = `<p style='color:#999;'>查詢中... (${i + 1}/${items.length})</p>`;

    const info = await fetchLastfmTrackInfo(artistName, trackName);

    const avgReplayPerListener =
      info.listeners && info.playcount && info.listeners > 0
        ? info.playcount / info.listeners
        : null;

    info.tags.forEach(tag => {
      const weight = tag.count || 1; // Last.fm 回傳的 count 是 0~100 的相對權重
      tagWeights[tag.name] = (tagWeights[tag.name] || 0) + weight;
    });

    enrichedTracks.push({
      artist: artistName,
      name: trackName,
      image: track.album.images?.[2]?.url || track.album.images?.[0]?.url,
      playedAt: new Date(played_at).toLocaleString("zh-TW", {
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      }),
      listeners: info.listeners,
      playcount: info.playcount,
      avgReplayPerListener,
      tags: info.tags.map(t => t.name),
    });
  }

  renderTrackList(enrichedTracks);
  renderQuickStats(enrichedTracks);
  renderWordCloud(tagWeights);

  document.getElementById("global-loading").style.display = "none";
}

// ========================================
// 查詢單一曲目在 Last.fm 的資訊:listeners / scrobbles(playcount) / 標籤
// 同一首歌(同歌手+同曲名)只查一次,結果共用快取
// Last.fm 對 JSON 回應開放 CORS,可直接 fetch
// ========================================
async function fetchLastfmTrackInfo(artistName, trackName) {
  const cacheKey = `${artistName.toLowerCase()}|||${trackName.toLowerCase()}`;
  if (trackInfoCache[cacheKey]) {
    return trackInfoCache[cacheKey];
  }

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
      result.tags = (data.track.toptags?.tag || []).map(t => ({
        name: t.name,
        count: Number(t.count) || 1,
      }));
    }
  } catch (err) {
    console.warn(`Last.fm 查詢失敗: ${artistName} - ${trackName}`, err.message);
  }

  trackInfoCache[cacheKey] = result;
  return result;
}

// ========================================
// 顯示歌單清單(含 listeners / scrobbles / 平均重播次數 / 標籤)
// ========================================
function renderTrackList(enrichedTracks) {
  const container = document.getElementById("track-list");
  container.innerHTML = "";

  enrichedTracks.forEach(({ artist, name, image, playedAt, listeners, playcount, avgReplayPerListener, tags }) => {
    const listenersText = listeners !== null ? listeners.toLocaleString() : "無資料";
    const playcountText = playcount !== null ? playcount.toLocaleString() : "無資料";
    const replayText = avgReplayPerListener !== null ? avgReplayPerListener.toFixed(1) : "—";
    const tagsHtml = tags.length > 0
      ? tags.slice(0, 5).map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")
      : `<span class="tag-chip">無標籤</span>`;

    const item = document.createElement("div");
    item.className = "track-item";
    item.innerHTML = `
      <img src="${image || ''}" width="60" height="60" onerror="this.style.visibility='hidden'">
      <div>
        <strong>${escapeHtml(name)}</strong> - ${escapeHtml(artist)}<br>
        <span class="track-stats">
          ${playedAt} ｜ 聽眾 ${listenersText} ｜ 播放 ${playcountText}
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
// 整體概況統計
// ========================================
function renderQuickStats(enrichedTracks) {
  const withData = enrichedTracks.filter(t => t.listeners && t.playcount);
  const avgListeners = withData.length > 0
    ? Math.round(withData.reduce((sum, t) => sum + t.listeners, 0) / withData.length)
    : null;
  const avgReplay = withData.length > 0
    ? (withData.reduce((sum, t) => sum + t.avgReplayPerListener, 0) / withData.length).toFixed(1)
    : null;

  // 「最忠實粉絲」歌曲:scrobbles/listeners 比例最高的一首(代表這首歌的聽眾特別愛重播)
  const mostReplayed = withData.reduce((max, t) =>
    (!max || t.avgReplayPerListener > max.avgReplayPerListener) ? t : max, null);

  // 最冷門(listeners 最少)的一首
  const mostRare = withData.reduce((min, t) =>
    (!min || t.listeners < min.listeners) ? t : min, null);

  document.getElementById("quick-stats-view").style.display = "block";
  document.getElementById("quick-stats").innerHTML = `
    <div class="quick-stat-item"><span class="quick-stat-label">平均聽眾數</span><span class="quick-stat-value">${avgListeners !== null ? avgListeners.toLocaleString() : "—"}</span></div>
    <div class="quick-stat-item"><span class="quick-stat-label">平均重播次數</span><span class="quick-stat-value">${avgReplay ?? "—"}</span></div>
    <div class="quick-stat-item"><span class="quick-stat-label">最多人重播</span><span class="quick-stat-value" style="font-size:13px;">${mostReplayed ? escapeHtml(mostReplayed.name) : "—"}</span></div>
    <div class="quick-stat-item"><span class="quick-stat-label">你的私藏冷門歌</span><span class="quick-stat-value" style="font-size:13px;">${mostRare ? escapeHtml(mostRare.name) : "—"}</span></div>
  `;
}

// ========================================
// 標籤文字雲(用 wordcloud2.js 畫在 canvas 上)
// 字越大代表這個標籤在你的 50 首歌裡權重越高
// ========================================
function renderWordCloud(tagWeights) {
  const entries = Object.entries(tagWeights);
  if (entries.length === 0) return;

  document.getElementById("wordcloud-view").style.display = "block";

  const canvas = document.getElementById("wordcloud-canvas");
  // 依容器實際寬度設定 canvas 解析度,避免模糊
  canvas.width = canvas.clientWidth;
  canvas.height = 360;

  const colors = ["#1DB954", "#d51007", "#ffffff", "#1ed760", "#ff6b5b", "#9b9b9b"];

  const list = entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60) // 最多顯示60個標籤,避免過度擁擠
    .map(([name, weight]) => [name, weight]);

  WordCloud(canvas, {
    list,
    gridSize: 8,
    weightFactor: (size) => Math.pow(size, 0.6) * 2.2,
    fontFamily: "Helvetica Neue, Arial, sans-serif",
    color: () => colors[Math.floor(Math.random() * colors.length)],
    backgroundColor: "transparent",
    rotateRatio: 0.3,
    rotationSteps: 2,
  });
}
