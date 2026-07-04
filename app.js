// ========================================
// 基本設定
// ========================================
const clientId = "18a7af28818a40abafa707e98e4d7a48";
const redirectUri = "https://pengoffline.github.io/entropic-spotify/index.html";

// 需要的權限:個人資料 + 最近聆聽紀錄
const scope = "user-read-private user-read-email user-read-recently-played";

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
      btn.classList.add("active"); // 預設選中的按鈕
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
// 抓取「最常聽」曲目(依時間範圍) + 歌手流派
// time_range: short_term(約4週) / medium_term(約6個月) / long_term(約數年)
// ========================================
async function fetchTopTracks(token, timeRange) {
  const container = document.getElementById("track-list");
  container.innerHTML = "<p style='color:#999;'>載入中...</p>";

  const res = await fetch(
    `https://api.spotify.com/v1/me/top/tracks?time_range=${timeRange}&limit=50`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    console.error("抓取最常聽曲目失敗", res.status);
    container.innerHTML = "<p style='color:#f66;'>抓取資料失敗,請稍後再試。</p>";
    return;
  }

  const data = await res.json();
  const tracks = data.items; // top/tracks 回傳的就是曲目本身,不像 recently-played 要多包一層 item.track

  // 蒐集所有出現過的 artist id(去重複),genre 掛在 artist 身上
  // 注意:Spotify 於 2026年2月移除了批次查詢端點 GET /v1/artists,
  // 現在只能用 GET /v1/artists/{id} 一個一個查詢
  const artistIds = [...new Set(tracks.map(t => t.artists[0].id))];
  const artistGenreMap = {};

  for (const artistId of artistIds) {
    try {
      const artistRes = await fetch(
        `https://api.spotify.com/v1/artists/${artistId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!artistRes.ok) {
        console.warn(`抓取歌手 ${artistId} 失敗`, artistRes.status);
        artistGenreMap[artistId] = [];
        continue;
      }
      const artist = await artistRes.json();
      artistGenreMap[artistId] = artist.genres || [];
    } catch (err) {
      console.warn(`抓取歌手 ${artistId} 發生例外`, err);
      artistGenreMap[artistId] = [];
    }
  }

  renderTracks(tracks, artistGenreMap);
  renderDecadeAnalysis(tracks);
}

// ========================================
// 顯示曲目清單(含發行年份 / 流行度 / 流派)
// ========================================
function renderTracks(tracks, artistGenreMap) {
  const container = document.getElementById("track-list");
  document.getElementById("history-view").style.display = "block";
  container.innerHTML = "";

  // 說明性註記:Spotify 於 2026年2月起,對新申請的開發者帳號移除了
  // track.popularity 欄位,且 artist.genres 資料本身也常常是空的(Spotify 資料品質問題)。
  // 這裡誠實顯示「無資料」而不是硬做假數據。
  const note = document.createElement("p");
  note.className = "no-data-note";
  note.textContent = "註:流行度欄位已被 Spotify 官方於個人開發者帳號中移除;部分歌手的流派資料 Spotify 本身也未提供分類。";
  container.appendChild(note);

  tracks.forEach(track => {
    const releaseYear = track.album.release_date?.split("-")[0] || "未知";
    const popularityText = (typeof track.popularity === "number") ? `${track.popularity}/100` : "無資料";
    const mainArtistId = track.artists[0].id;
    const genres = artistGenreMap[mainArtistId];
    const genreText = genres && genres.length > 0 ? genres.join(", ") : "無資料";

    const item = document.createElement("div");
    item.className = "track-item";
    item.innerHTML = `
      <img src="${track.album.images[2]?.url || track.album.images[0]?.url}" width="60" height="60">
      <div>
        <strong>${track.name}</strong> - ${track.artists.map(a => a.name).join(", ")}<br>
        <small>發行年份: ${releaseYear} ｜ 流行度: ${popularityText} ｜ 流派: ${genreText}</small>
      </div>
    `;
    container.appendChild(item);
  });
}

// ========================================
// 依年代分組 (1960s ~ 2020s) + Shannon Entropy
// ========================================

// 把發行年份轉換成所屬年代標籤,例如 1975 -> "1970s"
// 超出 1960-2020 範圍的歸類到 "其他"
function getDecadeLabel(releaseDate) {
  if (!releaseDate) return "其他";
  const year = parseInt(releaseDate.split("-")[0], 10);
  if (isNaN(year) || year < 1960 || year >= 2030) return "其他";
  const decadeStart = Math.floor(year / 10) * 10;
  return `${decadeStart}s`;
}

// 計算 Shannon Entropy: H = -Σ p_i * log2(p_i)
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

function renderDecadeAnalysis(tracks) {
  const decadeOrder = ["1960s", "1970s", "1980s", "1990s", "2000s", "2010s", "2020s"];

  // 初始化計數
  const counts = {};
  decadeOrder.forEach(d => (counts[d] = 0));
  let otherCount = 0;

  tracks.forEach(track => {
    const label = getDecadeLabel(track.album.release_date);
    if (label === "其他") {
      otherCount++;
    } else {
      counts[label]++;
    }
  });

  const totalClassified = Object.values(counts).reduce((a, b) => a + b, 0);

  // ---- 畫長條圖 (純 HTML/CSS,不需額外套件) ----
  const barsContainer = document.getElementById("decade-bars");
  barsContainer.innerHTML = "";
  const maxCount = Math.max(...Object.values(counts), 1);

  decadeOrder.forEach(decade => {
    const count = counts[decade];
    const widthPercent = (count / maxCount) * 100;

    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <div class="bar-label">${decade}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${widthPercent}%;"></div>
      </div>
      <div class="bar-count">${count}</div>
    `;
    barsContainer.appendChild(row);
  });

  if (otherCount > 0) {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <div class="bar-label">其他</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${(otherCount / maxCount) * 100}%; background:#666;"></div>
      </div>
      <div class="bar-count">${otherCount}</div>
    `;
    barsContainer.appendChild(row);
  }

  // ---- 計算並顯示 Shannon Entropy (只計算 1960s-2020s 分類內的曲目) ----
  const entropy = calculateShannonEntropy(counts);
  const maxPossibleEntropy = Math.log2(decadeOrder.length); // 若均勻分布在7個年代的理論最大值

  document.getElementById("decade-view").style.display = "block";
  document.getElementById("entropy-result").innerHTML = `
    H = ${entropy.toFixed(4)} bits
    <span style="color:#999; font-weight:normal; font-size:14px;">
      (最大可能值 ${maxPossibleEntropy.toFixed(4)} bits，共 ${totalClassified} 首納入計算${otherCount > 0 ? `，${otherCount} 首超出範圍未列入` : ""})
    </span>
  `;
}
