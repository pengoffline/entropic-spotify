// ========================================
// 基本設定
// ========================================
const clientId = "18a7af28818a40abafa707e98e4d7a48";
const redirectUri = "https://pengoffline.github.io/entropic-spotify/index.html";

// 需要的權限:個人資料 + 使用者最常聽曲目
const scope = "user-read-private user-read-email user-read-recently-played user-top-read";

// ========================================
// PKCE 工具函式
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
// JSONP 工具函式(讓純前端網站也能呼叫不支援 CORS 的 API)
// 原理:動態插入 <script> 標籤,瀏覽器對 <script src> 沒有同源限制
// ========================================
let jsonpCounter = 0;
function jsonp(url, callbackParamName = "callback", timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const callbackName = `jsonp_cb_${Date.now()}_${jsonpCounter++}`;
    const script = document.createElement("script");

    const cleanup = () => {
      delete window[callbackName];
      script.remove();
      clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("JSONP 請求逾時"));
    }, timeoutMs);

    window[callbackName] = (data) => {
      cleanup();
      resolve(data);
    };

    const separator = url.includes("?") ? "&" : "?";
    script.src = `${url}${separator}${callbackParamName}=${callbackName}`;
    script.onerror = () => {
      cleanup();
      reject(new Error("JSONP 請求失敗"));
    };
    document.body.appendChild(script);
  });
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

let currentToken = null; // 存起來讓時間範圍按鈕可以重複呼叫 API

// 三個維度正規化後的 entropy 百分比(0~100),算完幾何平均要用
const entropyPercents = { decade: null, fame: null, genre: null };

// 頂部總覽的四個補充統計欄位
const quickStats = { avgYear: null, avgFameLabel: null, favoriteDecade: null, favoriteGenre: null };

async function runAll(token) {
  currentToken = token;
  await fetchProfile(token);
  setupRangeButtons();
  await fetchTopTracks(token, "medium_term"); // 預設顯示「最近6個月」
}

// ========================================
// 時間範圍按鈕(最近4週 / 6個月 / 所有時間)
// ========================================
function setupRangeButtons() {
  const buttons = document.querySelectorAll(".range-btn");
  buttons.forEach(btn => {
    btn.addEventListener("click", () => {
      buttons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      fetchTopTracks(currentToken, btn.dataset.range);
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
  document.getElementById("email").textContent = profile.email || "無公開 email";
  if (profile.images?.[0]) {
    document.getElementById("avatar").src = profile.images[0].url;
  }
}

// ========================================
// 抓取「最常聽」曲目(依時間範圍)
// time_range: short_term(約4週) / medium_term(約6個月) / long_term(約數年)
// ========================================
async function fetchTopTracks(token, timeRange) {
  // 重置三個維度的暫存值,避免切換時間範圍時新舊資料混在一起算幾何平均
  entropyPercents.decade = null;
  entropyPercents.fame = null;
  entropyPercents.genre = null;
  quickStats.avgYear = null;
  quickStats.avgFameLabel = null;
  quickStats.favoriteDecade = null;
  quickStats.favoriteGenre = null;
  renderQuickStats();
  document.getElementById("taste-summary").style.display = "none";
  document.getElementById("decade-view").style.display = "none";
  document.getElementById("fame-view").style.display = "none";
  document.getElementById("genre-view").style.display = "none";

  // 立即顯示載入提示(修正原本訊息被藏在 display:none 容器裡看不到的問題)
  document.getElementById("global-loading").style.display = "block";
  document.getElementById("history-view").style.display = "block";

  const container = document.getElementById("track-list");
  container.innerHTML = "<p style='color:#999;'>載入中,請稍候(正在查詢 Deezer 資料庫)...</p>";

  const res = await fetch(
    `https://api.spotify.com/v1/me/top/tracks?time_range=${timeRange}&limit=50`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    console.error("抓取最常聽曲目失敗", res.status);
    container.innerHTML = "<p style='color:#f66;'>抓取資料失敗,請稍後再試。</p>";
    document.getElementById("global-loading").style.display = "none";
    return;
  }

  // 先抓 Deezer 完整流派清單,當作 entropy 的固定分母
  const fixedGenreList = await fetchDeezerGenreList();

  const data = await res.json();
  const tracks = data.items;

  // ---- 1) Spotify 歌手流派(當作備援來源,常常是空的)----
  const artistIds = [...new Set(tracks.map(t => t.artists[0].id))];
  const spotifyGenreMap = {};

  for (const artistId of artistIds) {
    try {
      const artistRes = await fetch(
        `https://api.spotify.com/v1/artists/${artistId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!artistRes.ok) {
        spotifyGenreMap[artistId] = [];
        continue;
      }
      const artist = await artistRes.json();
      spotifyGenreMap[artistId] = artist.genres || [];
    } catch (err) {
      spotifyGenreMap[artistId] = [];
    }
  }

  // ---- 2) 逐首曲目查詢 Deezer(知名度 rank + 專輯流派,同專輯共用快取)----
  const albumGenreCache = {}; // albumId -> genre string 或 null,避免同專輯重複查詢
  const enrichedTracks = [];
  for (const track of tracks) {
    const artistName = track.artists[0].name;
    const trackName = track.name;

    const deezerData = await fetchDeezerData(trackName, artistName, track.external_ids?.isrc);

    let genre = null;
    if (deezerData?.albumId) {
      if (deezerData.albumId in albumGenreCache) {
        genre = albumGenreCache[deezerData.albumId];
      } else {
        genre = await fetchDeezerAlbumGenre(deezerData.albumId);
        albumGenreCache[deezerData.albumId] = genre;
      }
    }

    // Deezer 查無流派時,退回 Spotify 的歌手分類(常常是空的,但聊勝於無)
    if (!genre) {
      const spotifyGenres = spotifyGenreMap[track.artists[0].id] || [];
      genre = spotifyGenres.length > 0 ? spotifyGenres[0] : null;
    }

    enrichedTracks.push({
      track,
      fameRank: deezerData?.rank ?? null,
      genre,
    });

    container.innerHTML = `<p style='color:#999;'>查詢中... (${enrichedTracks.length}/${tracks.length})</p>`;
  }

  renderTracks(enrichedTracks);
  renderDecadeAnalysis(tracks);
  renderFameAnalysis(enrichedTracks);
  renderGenreAnalysis(enrichedTracks);
}

// ========================================
// 取得 Deezer 完整流派清單(只需抓一次,快取起來)
// 這份清單會當作流派 entropy 的「固定分母」,
// 而不是只用使用者實際聽過的流派種類數(這樣不同人才能公平比較)
// ========================================
let deezerGenreListCache = null;

async function fetchDeezerGenreList() {
  if (deezerGenreListCache) return deezerGenreListCache;
  try {
    const data = await jsonp("https://api.deezer.com/genre?output=jsonp");
    if (data && data.data) {
      // 排除 "All" 這個萬用統包分類,只留實際的流派
      deezerGenreListCache = data.data
        .map(g => g.name)
        .filter(name => name && name.toLowerCase() !== "all");

      // 印到 console,方便你自己核對(這是即時抓取的真實資料,不是我憑印象列的)
      console.log(`Deezer 目前共有 ${deezerGenreListCache.length} 種流派:`, deezerGenreListCache);

      const listEl = document.getElementById("deezer-genre-full-list");
      if (listEl) {
        listEl.textContent = `共 ${deezerGenreListCache.length} 種: ${deezerGenreListCache.join("、")}`;
      }
    } else {
      deezerGenreListCache = [];
    }
  } catch (err) {
    console.warn("抓取 Deezer 流派清單失敗", err.message);
    deezerGenreListCache = [];
  }
  return deezerGenreListCache;
}

// ========================================
// Deezer:優先用 ISRC(國際標準錄音代碼)做精確比對,
// 查無 ISRC 或查詢失敗時,才退回用曲名+歌手名模糊搜尋
// 回傳 { rank, albumId },查無資料回傳 null
// 免費、不需要 API key,但不支援 CORS,所以用 JSONP 繞過
// ========================================
async function fetchDeezerData(trackName, artistName, isrc) {
  // 優先:ISRC 精確查詢
  if (isrc) {
    try {
      const url = `https://api.deezer.com/track/isrc:${isrc}?output=jsonp`;
      const data = await jsonp(url);
      if (data && typeof data.rank === "number") {
        return { rank: data.rank, albumId: data.album?.id ?? null };
      }
    } catch (err) {
      console.warn(`Deezer ISRC 查詢失敗: ${isrc}`, err.message);
    }
  }

  // 備援:曲名+歌手名模糊搜尋
  try {
    const query = encodeURIComponent(`artist:"${artistName}" track:"${trackName}"`);
    const url = `https://api.deezer.com/search/track?q=${query}&output=jsonp`;
    const data = await jsonp(url);
    if (data && data.data && data.data.length > 0) {
      const match = data.data[0];
      return { rank: match.rank ?? null, albumId: match.album?.id ?? null };
    }
    return null;
  } catch (err) {
    console.warn(`Deezer 曲名搜尋失敗: ${artistName} - ${trackName}`, err.message);
    return null;
  }
}

// ========================================
// Deezer:用專輯 ID 查詢該專輯的流派分類
// ========================================
async function fetchDeezerAlbumGenre(albumId) {
  try {
    const url = `https://api.deezer.com/album/${albumId}?output=jsonp`;
    const data = await jsonp(url);
    if (data && data.genres && data.genres.data && data.genres.data.length > 0) {
      return data.genres.data[0].name;
    }
    return null;
  } catch (err) {
    console.warn(`Deezer 專輯流派查詢失敗: album ${albumId}`, err.message);
    return null;
  }
}

// ========================================
// 顯示曲目清單(含發行年份 / 知名度 / 流派)
// ========================================
function renderTracks(enrichedTracks) {
  const container = document.getElementById("track-list");
  document.getElementById("history-view").style.display = "block";
  container.innerHTML = "";

  const note = document.createElement("p");
  note.className = "no-data-note";
  note.textContent = "註:知名度與流派皆來自 Deezer(同專輯的歌曲共用查詢結果以加速);查無資料時退回 Spotify 分類(Spotify 原生流行度欄位已被官方停止提供)。";
  container.appendChild(note);

  enrichedTracks.forEach(({ track, fameRank, genre }) => {
    const releaseYear = track.album.release_date?.split("-")[0] || "未知";

    // 知名度改顯示級距標籤(附上原始 rank 供參考)
    const fameLabel = getFameLabel(fameRank);
    const fameText = fameLabel === "無資料" ? "無資料" : `${fameLabel}(rank ${fameRank.toLocaleString()})`;

    // 流派改顯示歸類後的12組,對照不到的顯示「其他」
    let genreText = "無資料";
    if (genre) {
      genreText = GENRE_GROUP_MAP[genre] || "其他";
    }

    const item = document.createElement("div");
    item.className = "track-item";
    item.innerHTML = `
      <img src="${track.album.images[2]?.url || track.album.images[0]?.url}" width="60" height="60">
      <div>
        <strong>${track.name}</strong> - ${track.artists.map(a => a.name).join(", ")}<br>
        <small>發行年份: ${releaseYear} ｜ 知名度: ${fameText} ｜ 流派: ${genreText}</small>
      </div>
    `;
    container.appendChild(item);
  });
}

// ========================================
// 通用工具:計算 Shannon Entropy 與畫長條圖
// H = -Σ p_i * log2(p_i)
// ========================================
function calculateShannonEntropy(counts) {
  const total = Object.values(counts).reduce((sum, c) => sum + c, 0);
  if (total === 0) return 0;

  let entropy = 0;
  for (const count of Object.values(counts)) {
    if (count === 0) continue;
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ========================================
// 產生圓形進度條 SVG,percent: 0~100
// ========================================
function generateCircularProgressSVG(percent, size = 90, strokeWidth = 9, color = "#1DB954") {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clampedPercent = Math.max(0, Math.min(100, percent));
  const offset = circumference - (clampedPercent / 100) * circumference;
  const center = size / 2;

  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex-shrink:0;">
      <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="#333" stroke-width="${strokeWidth}" />
      <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"
        stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" stroke-linecap="round"
        transform="rotate(-90 ${center} ${center})" style="transition: stroke-dashoffset 0.6s ease;" />
      <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#fff"
        font-size="${size * 0.22}" font-weight="bold">${clampedPercent.toFixed(0)}%</text>
    </svg>
  `;
}

function renderBarChart(containerId, counts, orderedLabels) {
  const barsContainer = document.getElementById(containerId);
  barsContainer.innerHTML = "";
  const maxCount = Math.max(...Object.values(counts), 1);

  orderedLabels.forEach(label => {
    const count = counts[label] || 0;
    const widthPercent = (count / maxCount) * 100;

    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <div class="bar-label">${label}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${widthPercent}%;"></div>
      </div>
      <div class="bar-count">${count}</div>
    `;
    barsContainer.appendChild(row);
  });
}

// ========================================
// 頂部總覽的四個補充統計欄位:
// 平均年份 / 流行程度(依分組資料平均)/ 最愛年代(眾數) / 最愛類型(眾數)
// 每個欄位各自獨立顯示,不用等三個維度都算完
// ========================================
function renderQuickStats() {
  const el = document.getElementById("quick-stats");
  if (!el) return;

  el.innerHTML = `
    <div class="quick-stat-item"><span class="quick-stat-label">平均年份</span><span class="quick-stat-value">${quickStats.avgYear ?? "—"}</span></div>
    <div class="quick-stat-item"><span class="quick-stat-label">流行程度</span><span class="quick-stat-value">${quickStats.avgFameLabel ?? "—"}</span></div>
    <div class="quick-stat-item"><span class="quick-stat-label">最愛年代</span><span class="quick-stat-value">${quickStats.favoriteDecade ?? "—"}</span></div>
    <div class="quick-stat-item"><span class="quick-stat-label">最愛類型</span><span class="quick-stat-value">${quickStats.favoriteGenre ?? "—"}</span></div>
  `;
}

// ========================================
// 品味混亂程度:三個維度依各自的分類數量加權平均
// 年代7組、知名度5組、流派12組,分類越細的維度權重越高
// 綜合值 = (7×年代% + 5×知名度% + 12×流派%) / (7+5+12)
// ========================================
function renderTasteSummary() {
  const { decade, fame, genre } = entropyPercents;
  if (decade === null || fame === null || genre === null) return; // 還沒算齊三個,先不顯示

  const WEIGHT_DECADE = 7;
  const WEIGHT_FAME = 5;
  const WEIGHT_GENRE = 12;
  const totalWeight = WEIGHT_DECADE + WEIGHT_FAME + WEIGHT_GENRE;

  const weightedScore = (WEIGHT_DECADE * decade + WEIGHT_FAME * fame + WEIGHT_GENRE * genre) / totalWeight;

  document.getElementById("taste-summary").style.display = "block";
  document.getElementById("taste-summary-value").innerHTML = generateCircularProgressSVG(weightedScore, 140, 14, "#1DB954");
  document.getElementById("taste-summary-breakdown").innerHTML = `
    年代多元度: ${decade.toFixed(1)}%(權重7) ｜ 知名度多元度: ${fame.toFixed(1)}%(權重5) ｜ 流派多元度: ${genre.toFixed(1)}%(權重12)
  `;
  document.getElementById("global-loading").style.display = "none";
}

// ========================================
// 【維度一】依年代分組 (1960s ~ 2020s) + Shannon Entropy
// ========================================
function getDecadeLabel(releaseDate) {
  if (!releaseDate) return "其他";
  const year = parseInt(releaseDate.split("-")[0], 10);
  if (isNaN(year) || year < 1960 || year >= 2030) return "其他";
  const decadeStart = Math.floor(year / 10) * 10;
  return `${decadeStart}s`;
}

function renderDecadeAnalysis(tracks) {
  const decadeOrder = ["1960s", "1970s", "1980s", "1990s", "2000s", "2010s", "2020s"];
  const counts = {};
  decadeOrder.forEach(d => (counts[d] = 0));
  let otherCount = 0;
  let yearSum = 0;
  let yearCount = 0;

  tracks.forEach(track => {
    const label = getDecadeLabel(track.album.release_date);
    if (label === "其他") otherCount++;
    else counts[label]++;

    const year = parseInt(track.album.release_date?.split("-")[0], 10);
    if (!isNaN(year)) {
      yearSum += year;
      yearCount++;
    }
  });

  // 平均年份(全部曲目,不限1960-2020區間)
  if (yearCount > 0) {
    quickStats.avgYear = (yearSum / yearCount).toFixed(1);
  }

  // 最愛年代:眾數(只在固定7個年代裡取,不含「其他」)
  const maxDecadeCount = Math.max(...decadeOrder.map(d => counts[d]));
  if (maxDecadeCount > 0) {
    quickStats.favoriteDecade = decadeOrder.find(d => counts[d] === maxDecadeCount);
  }

  const totalClassified = Object.values(counts).reduce((a, b) => a + b, 0);
  renderBarChart("decade-bars", counts, decadeOrder);

  if (otherCount > 0) {
    const barsContainer = document.getElementById("decade-bars");
    const maxCount = Math.max(...Object.values(counts), 1);
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <div class="bar-label">其他</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(otherCount / maxCount) * 100}%; background:#666;"></div></div>
      <div class="bar-count">${otherCount}</div>
    `;
    barsContainer.appendChild(row);
  }

  const entropy = calculateShannonEntropy(counts);
  const maxPossibleEntropy = Math.log2(decadeOrder.length);
  const percent = maxPossibleEntropy > 0 ? (entropy / maxPossibleEntropy) * 100 : 0;
  entropyPercents.decade = percent;

  document.getElementById("decade-view").style.display = "block";
  document.getElementById("decade-entropy-result").innerHTML = `
    <div class="entropy-row">
      ${generateCircularProgressSVG(percent, 90, 9)}
      <div>
        <div style="font-size:15px; color:#ccc;">年代多元度</div>
        <span style="color:#999; font-size:13px;">
          H = ${entropy.toFixed(4)} / 最大值 ${maxPossibleEntropy.toFixed(4)} bits<br>
          共 ${totalClassified} 首納入計算${otherCount > 0 ? `，${otherCount} 首超出範圍未列入` : ""}
        </span>
      </div>
    </div>
  `;
  renderTasteSummary();
  renderQuickStats();
}

// ========================================
// 【維度二】依知名度分組(Deezer rank) + Shannon Entropy
// 分級門檻是依 Deezer rank 概略估計,非官方公告的絕對標準
// ========================================
function getFameLabel(rank) {
  if (typeof rank !== "number") return "無資料";
  if (rank >= 750000) return "超夯";
  if (rank >= 250000) return "主流";
  if (rank >= 75000) return "普通";
  if (rank >= 25000) return "小眾";
  return "稀有";
}

const FAME_ORDER = ["稀有", "小眾", "普通", "主流", "超夯"];

function renderFameAnalysis(enrichedTracks) {
  const fameOrder = FAME_ORDER;
  const counts = {};
  fameOrder.forEach(f => (counts[f] = 0));
  let noDataCount = 0;
  let ordinalSum = 0;
  let ordinalCount = 0;

  enrichedTracks.forEach(({ fameRank }) => {
    const label = getFameLabel(fameRank);
    if (label === "無資料") {
      noDataCount++;
    } else {
      counts[label]++;
      ordinalSum += fameOrder.indexOf(label) + 1; // 1~5
      ordinalCount++;
    }
  });

  // 依「分組後」的資料算平均流行程度,而不是直接平均原始 rank 數字
  if (ordinalCount > 0) {
    const avgOrdinal = Math.round(ordinalSum / ordinalCount);
    const clamped = Math.min(fameOrder.length, Math.max(1, avgOrdinal));
    quickStats.avgFameLabel = fameOrder[clamped - 1];
  }

  const totalClassified = Object.values(counts).reduce((a, b) => a + b, 0);
  renderBarChart("fame-bars", counts, fameOrder);

  const entropy = calculateShannonEntropy(counts);
  const maxPossibleEntropy = Math.log2(fameOrder.length);
  const percent = maxPossibleEntropy > 0 ? (entropy / maxPossibleEntropy) * 100 : 0;
  entropyPercents.fame = percent;

  document.getElementById("fame-view").style.display = "block";
  document.getElementById("fame-entropy-result").innerHTML = `
    <div class="entropy-row">
      ${generateCircularProgressSVG(percent, 90, 9)}
      <div>
        <div style="font-size:15px; color:#ccc;">知名度多元度</div>
        <span style="color:#999; font-size:13px;">
          H = ${entropy.toFixed(4)} / 最大值 ${maxPossibleEntropy.toFixed(4)} bits<br>
          共 ${totalClassified} 首納入計算${noDataCount > 0 ? `，${noDataCount} 首查無資料未列入` : ""}
        </span>
      </div>
    </div>
  `;
  renderTasteSummary();
  renderQuickStats();
}

// ========================================
// 流派分組對照表:把 Deezer 原始流派歸類成 12 個固定大類
// 對照不到的原始流派會歸入「其他」,entropy 分母仍固定是 12(不含其他)
// ========================================
const GENRE_GROUP_MAP = {
  "Pop": "流行",
  "Dance": "流行",
  "Rap/Hip Hop": "嘻哈",
  "Rock": "搖滾",
  "Metal": "搖滾",
  "R&B": "R&B",
  "Soul & Funk": "R&B",
  "Reggae": "R&B",
  "Alternative": "另類",
  "Electro": "電子",
  "Folk": "民謠",
  "Jazz": "爵士",
  "Blues": "爵士",
  "Classical": "古典",
  "Asian Music": "亞洲",
  "Indian Music": "亞洲",
  "Latin Music": "世界",
  "Brazilian Music": "世界",
  "African Music": "世界",
  "Films/Games": "配樂",
};

const GENRE_GROUP_ORDER = ["流行", "嘻哈", "搖滾", "R&B", "另類", "電子", "民謠", "爵士", "古典", "亞洲", "世界", "配樂"];

// ========================================
// 【維度三】依流派分組(固定12組) + Shannon Entropy
// 不管使用者這次聽到哪些流派,一律顯示全部12組長條(沒聽過的顯示0),
// entropy 分母固定是 log2(12),可跨時間、跨使用者公平比較
// ========================================
function renderGenreAnalysis(enrichedTracks) {
  const counts = {};
  GENRE_GROUP_ORDER.forEach(g => (counts[g] = 0));
  let otherCount = 0;   // 原始流派對照不到這12組的(理論上少見)
  let noDataCount = 0;  // 完全查無流派資料

  enrichedTracks.forEach(({ genre }) => {
    if (!genre) {
      noDataCount++;
      return;
    }
    const group = GENRE_GROUP_MAP[genre];
    if (group) {
      counts[group]++;
    } else {
      otherCount++;
    }
  });

  const totalClassified = Object.values(counts).reduce((a, b) => a + b, 0);

  // 最愛類型:眾數(只在固定12組裡取,不含「其他」)
  const maxGenreCount = Math.max(...GENRE_GROUP_ORDER.map(g => counts[g]));
  if (maxGenreCount > 0) {
    quickStats.favoriteGenre = GENRE_GROUP_ORDER.find(g => counts[g] === maxGenreCount);
  }

  // 固定顯示全部12組,不管有沒有聽過
  renderBarChart("genre-bars", counts, GENRE_GROUP_ORDER);

  if (otherCount > 0) {
    const barsContainer = document.getElementById("genre-bars");
    const maxCount = Math.max(...Object.values(counts), 1);
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <div class="bar-label">其他</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(otherCount / maxCount) * 100}%; background:#666;"></div></div>
      <div class="bar-count">${otherCount}</div>
    `;
    barsContainer.appendChild(row);
  }

  // entropy 計算只用固定12組(不含「其他」),分母固定是 log2(12)
  const entropy = calculateShannonEntropy(counts);
  const maxPossibleEntropy = Math.log2(GENRE_GROUP_ORDER.length);
  const percent = maxPossibleEntropy > 0 ? (entropy / maxPossibleEntropy) * 100 : 0;
  entropyPercents.genre = percent;

  document.getElementById("genre-view").style.display = "block";
  document.getElementById("genre-entropy-result").innerHTML = `
    <div class="entropy-row">
      ${generateCircularProgressSVG(percent, 90, 9)}
      <div>
        <div style="font-size:15px; color:#ccc;">流派多元度</div>
        <span style="color:#999; font-size:13px;">
          H = ${entropy.toFixed(4)} / 最大值 ${maxPossibleEntropy.toFixed(4)} bits(固定12大類)<br>
          共 ${totalClassified} 首納入計算${otherCount > 0 ? `，${otherCount} 首歸類為其他` : ""}${noDataCount > 0 ? `，${noDataCount} 首查無資料` : ""}
        </span>
      </div>
    </div>
  `;
  renderTasteSummary();
  renderQuickStats();
}
