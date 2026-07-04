const clientId = "你的_CLIENT_ID"; // 換成你自己的
const redirectUri = "https://你的帳號.github.io/你的repo/"; // 要跟Dashboard設定的一致

// ---- 產生 PKCE 用的隨機字串與雜湊 ----
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

// ---- 登入按鈕:導向 Spotify 授權頁 ----
document.getElementById("login-btn")?.addEventListener("click", async () => {
  const codeVerifier = generateRandomString(64);
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // 存起來,等一下換 token 要用
  localStorage.setItem("code_verifier", codeVerifier);

  const scope = "user-read-private user-read-email";
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

// ---- 頁面載入時檢查網址是否帶有 code(表示剛授權完被導回)----
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
      // 清掉網址上的 code,避免重複使用
      window.history.replaceState({}, document.title, redirectUri);
      fetchProfile(data.access_token);
    } else {
      console.error("換取 token 失敗", data);
    }
  } else if (localStorage.getItem("access_token")) {
    fetchProfile(localStorage.getItem("access_token"));
  }
});

// ---- 抓取使用者資料 ----
async function fetchProfile(token) {
  const res = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    console.error("抓取使用者資料失敗", res.status);
    localStorage.removeItem("access_token"); // token 可能過期
    return;
  }

  const profile = await res.json();

  document.getElementById("login-view").style.display = "none";
  document.getElementById("profile-view").style.display = "block";
  document.getElementById("display-name").textContent = profile.display_name;
  document.getElementById("email").textContent = profile.email || "無公開email";
  if (profile.images?.[0]) {
    document.getElementById("avatar").src = profile.images[0].url;
  }
}
