import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { PARTIES, COUNTRIES, QUESTIONS, computeScores, COUNTRY_NAME_ZH, findNearestParty, economicLabel, politicalSystemLabel, democracyLabel, individualLabel, getTierLabel, ECONOMIC_EXPLANATIONS, DEMOCRACY_EXPLANATIONS, INDIVIDUAL_EXPLANATIONS, SOCIAL_EXPLANATION_FIXED } from "./data.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------
let currentIndex = 0;
const answers = {};
let scores = null;
let historyResults = []; // fetched from supabase
// 每張圖各自獨立控制三個圖層開關:政黨(party)、國家(country)、所有填答者(all)
let chartMode = {
  eqli: { party: true, country: false, all: false },
  indem: { party: true, country: false, all: false },
};

// ---------------------------------------------------------------
// Screens
// ---------------------------------------------------------------
const screens = {
  intro: document.getElementById("screen-intro"),
  quiz: document.getElementById("screen-quiz"),
  result: document.getElementById("screen-result"),
};
function showScreen(name) {
  for (const key in screens) screens[key].classList.toggle("hidden", key !== name);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.getElementById("start-btn").addEventListener("click", () => {
  currentIndex = 0;
  showScreen("quiz");
  renderQuestion();
});

document.getElementById("restart-btn").addEventListener("click", () => {
  for (const k in answers) delete answers[k];
  currentIndex = 0;
  scores = null;
  showScreen("intro");
});

// ---------------------------------------------------------------
// Quiz rendering
// ---------------------------------------------------------------
const quizRoot = document.getElementById("quiz-root");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");

const GROUP_STEM = {
  1: "你比較支持以下的哪個敘述？",
  2: "你認為以下政策或制度有多重要？",
  3: "你有多同意以下政策或制度？",
  4: "你認為以下敘述是完全不正當、還是總是正當的？",
};

function renderQuestion() {
  const q = QUESTIONS[currentIndex];
  progressLabel.textContent = `Q${String(currentIndex + 1).padStart(2, "0")} / ${QUESTIONS.length}`;
  progressFill.style.width = `${(currentIndex / QUESTIONS.length) * 100}%`;

  const stem = GROUP_STEM[q.group];
  let bodyHtml = "";

  if (q.scale === "pair10") {
    bodyHtml = `
      <p class="q-text">${stem}</p>
      <div class="pair-labels"><span>${q.left}</span><span>${q.right}</span></div>
      <div class="scale-row" role="group" aria-label="1到10選擇">
        ${Array.from({ length: 10 }, (_, i) => i + 1)
          .map((n) => scaleBtn(q.id, n, answers[q.id]))
          .join("")}
      </div>
      <div class="scale-endlabels"><span>1</span><span>10</span></div>
    `;
  } else if (q.scale === "importance10") {
    bodyHtml = `
      <p class="q-text">${stem}</p>
      <p class="q-item">${q.text}</p>
      <div class="scale-row" role="group" aria-label="1到10重要程度">
        ${Array.from({ length: 10 }, (_, i) => i + 1)
          .map((n) => scaleBtn(q.id, n, answers[q.id]))
          .join("")}
      </div>
      <div class="scale-endlabels"><span>完全不重要</span><span>非常重要</span></div>
    `;
  } else if (q.scale === "justify10") {
    bodyHtml = `
      <p class="q-text">${stem}</p>
      <p class="q-item">${q.text}</p>
      <div class="scale-row" role="group" aria-label="1到10正當程度">
        ${Array.from({ length: 10 }, (_, i) => i + 1)
          .map((n) => scaleBtn(q.id, n, answers[q.id]))
          .join("")}
      </div>
      <div class="scale-endlabels"><span>從不正當</span><span>總是正當</span></div>
    `;
  } else if (q.scale === "agree4") {
    bodyHtml = `
      <p class="q-text">${stem}</p>
      <p class="q-item">${q.text}</p>
      <div class="scale-row of4" role="group" aria-label="1到4同意程度">
        ${[1, 2, 3, 4].map((n) => scaleBtn(q.id, n, answers[q.id])).join("")}
      </div>
      <div class="scale-endlabels"><span>非常不同意</span><span>非常同意</span></div>
    `;
  }

  quizRoot.innerHTML = `
    <div class="q-card">
      ${bodyHtml}
    </div>
    <div class="nav-row">
      <button class="btn secondary" id="prev-btn" ${currentIndex === 0 ? "disabled" : ""}>← 上一題</button>
      <span class="nav-hint">${answers[q.id] !== undefined ? "已作答" : "請選擇一個答案"}</span>
      <button class="btn" id="next-btn" ${answers[q.id] === undefined ? "disabled" : ""}>
        ${currentIndex === QUESTIONS.length - 1 ? "完成測驗 →" : "下一題 →"}
      </button>
    </div>
  `;

  quizRoot.querySelectorAll("[data-qid]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const qid = btn.getAttribute("data-qid");
      const val = Number(btn.getAttribute("data-val"));
      answers[qid] = val;
      renderQuestion();
      // auto-advance shortly after any answer selection
      setTimeout(() => goNext(), 180);
    });
  });

  const prevBtn = document.getElementById("prev-btn");
  const nextBtn = document.getElementById("next-btn");
  if (prevBtn) prevBtn.addEventListener("click", goPrev);
  if (nextBtn) nextBtn.addEventListener("click", goNext);
}

function scaleBtn(qid, n, selectedVal) {
  const sel = selectedVal === n ? "selected" : "";
  return `<button class="scale-btn ${sel}" data-qid="${qid}" data-val="${n}">${n}</button>`;
}

function goPrev() {
  if (currentIndex > 0) {
    currentIndex -= 1;
    renderQuestion();
  }
}
function goNext() {
  if (answers[QUESTIONS[currentIndex].id] === undefined) return;
  if (currentIndex < QUESTIONS.length - 1) {
    currentIndex += 1;
    renderQuestion();
  } else {
    finishQuiz();
  }
}

// ---------------------------------------------------------------
// Finish → compute scores → show results
// ---------------------------------------------------------------
async function finishQuiz() {
  scores = computeScores(answers);
  showScreen("result");
  renderIdeologyPanel();
  await refreshHistoryAndDraw();
}

// value 假設落在 1-10 尺度上,轉成 0-100 的百分比位置
function toPercent(value) {
  const p = ((value - 1) / 9) * 100;
  return Math.max(0, Math.min(100, p));
}

function bigBarHTML({ axisName, leftLabel, rightLabel, percent, tier, valueDisplay, explanationPlaceholder }) {
  return `
    <div class="ibar-row">
      <div class="ibar-tier">${axisName}：${tier}<span class="ibar-tier-value">(${valueDisplay})</span></div>
      <div class="ibar-track big">
        <div class="ibar-fill-left" style="width:${percent}%"></div>
        <div class="ibar-fill-right" style="width:${100 - percent}%"></div>
        <div class="ibar-marker" style="left:${percent}%"></div>
      </div>
      <div class="ibar-endlabels"><span>${leftLabel}</span><span>${rightLabel}</span></div>
      <p class="ibar-explanation placeholder">${explanationPlaceholder}</p>
    </div>
  `;
}

function smallBarHTML({ label, percent, valueDisplay, tier, leftLabel, rightLabel, explanationPlaceholder }) {
  return `
    <div class="ibar-row small">
      <div class="ibar-small-header"><span>${label}</span><strong>${tier}<span class="ibar-tier-value">(${valueDisplay})</span></strong></div>
      <div class="ibar-track small">
        <div class="ibar-fill-single" style="width:${percent}%"></div>
      </div>
      <div class="ibar-endlabels"><span>${leftLabel}</span><span>${rightLabel}</span></div>
      <p class="ibar-explanation placeholder">${explanationPlaceholder}</p>
    </div>
  `;
}

function renderIdeologyPanel() {
  const { party, distance } = findNearestParty(scores);
  let matchSentence;
  if (distance <= 1.5) {
    const countryZh = COUNTRY_NAME_ZH[party.country] || party.country;
    matchSentence = `你的意識形態和 <strong>${countryZh} ${party.party}</strong> 支持者最接近`;
  } else {
    matchSentence = "你的意識形態不接近以下任何政黨";
  }

  const econTier = economicLabel(scores.equality);
  const polityTier = politicalSystemLabel(scores.liberty);

  // 經濟軸:平等分數越高越「左」,所以左端點放高分那一側
  const econPercent = 100 - toPercent(scores.equality);
  // 社會軸:自由分數越高越靠「自由意志」端(放右側)
  const polityPercent = toPercent(scores.liberty);

  document.getElementById("ideology-panel").innerHTML = `
    <p class="match-sentence">${matchSentence}</p>

    ${bigBarHTML({
      axisName: "經濟",
      leftLabel: "平等", rightLabel: "市場",
      percent: econPercent, tier: econTier, valueDisplay: scores.equality,
      explanationPlaceholder: ECONOMIC_EXPLANATIONS[econTier] || "",
    })}
    ${bigBarHTML({
      axisName: "社會",
      leftLabel: "威權", rightLabel: "自由",
      percent: polityPercent, tier: polityTier, valueDisplay: scores.liberty,
      explanationPlaceholder: SOCIAL_EXPLANATION_FIXED,
    })}

    <div class="ibar-small-group">
      ${smallBarHTML({
        label: "政治體制", percent: toPercent(scores.democracy), valueDisplay: scores.democracy,
        tier: democracyLabel(scores.democracy), leftLabel: "威權", rightLabel: "民主",
        explanationPlaceholder: DEMOCRACY_EXPLANATIONS[democracyLabel(scores.democracy)] || "",
      })}
      ${smallBarHTML({
        label: "個人選擇", percent: toPercent(scores.individual), valueDisplay: scores.individual,
        tier: individualLabel(scores.individual), leftLabel: "傳統", rightLabel: "進步",
        explanationPlaceholder: INDIVIDUAL_EXPLANATIONS[individualLabel(scores.individual)] || "",
      })}
    </div>

    <div class="ibar-overall-note placeholder">
      （這裡放不會隨結果改變的總體說明文字,例如整份測驗的計分邏輯或四個維度的關係,請自行填寫）
    </div>
  `;
}

// ---------------------------------------------------------------
// Chart rendering (SVG, range 1-10, gridline every 1.0)
// ---------------------------------------------------------------
const CHART_SIZE = 680;
const MARGIN = { top: 40, right: 46, bottom: 62, left: 70 };
const PLOT = CHART_SIZE - MARGIN.left - MARGIN.right;
const MIN_V = 1, MAX_V = 10;

function scalePos(v) {
  return ((v - MIN_V) / (MAX_V - MIN_V)) * PLOT;
}

function buildChartSVG({ xKey, yKey, xLabel, yLabel, poleLabels, myPoint, otherPoints, showParty, showCountry, showAll }) {
  const w = CHART_SIZE;
  const h = CHART_SIZE;
  const gx = (v) => MARGIN.left + scalePos(v);
  const gy = (v) => h - MARGIN.bottom - scalePos(v);

  let gridLines = "";
  for (let v = MIN_V; v <= MAX_V; v++) {
    const x = gx(v);
    const y = gy(v);
    gridLines += `<line x1="${x}" y1="${MARGIN.top}" x2="${x}" y2="${h - MARGIN.bottom}" stroke="#D8D3CF" stroke-width="1"/>`;
    gridLines += `<line x1="${MARGIN.left}" y1="${y}" x2="${w - MARGIN.right}" y2="${y}" stroke="#D8D3CF" stroke-width="1"/>`;
    gridLines += `<text x="${x}" y="${h - MARGIN.bottom + 18}" font-size="11" text-anchor="middle">${v}</text>`;
    gridLines += `<text x="${MARGIN.left - 10}" y="${y + 4}" font-size="11" text-anchor="end">${v}</text>`;
  }
  // 中線:1-10 尺度的中點是 5.5
  const cx = gx(5.5), cy = gy(5.5);
  gridLines += `<line x1="${cx}" y1="${MARGIN.top}" x2="${cx}" y2="${h - MARGIN.bottom}" stroke="#B9B2AA" stroke-width="1" stroke-dasharray="4 4"/>`;
  gridLines += `<line x1="${MARGIN.left}" y1="${cy}" x2="${w - MARGIN.right}" y2="${cy}" stroke="#B9B2AA" stroke-width="1" stroke-dasharray="4 4"/>`;

  let partyDots = "";
  if (showParty) {
    for (const p of PARTIES) {
      const x = gx(p[xKey]);
      const y = gy(p[yKey]);
      const countryZh = COUNTRY_NAME_ZH[p.country] || p.country;
      const title = p.year ? `${countryZh} ${p.party} (${p.year})` : `${countryZh} ${p.party}`;
      const nAttr = p.n ? ` data-n="${p.n}"` : "";
      partyDots += `<circle class="party-dot dot-click" cx="${x}" cy="${y}" r="4"
        data-title="${title}"${nAttr} data-xdim="${xKey}" data-xlabel="${xLabel}" data-xval="${p[xKey]}" data-ydim="${yKey}" data-ylabel="${yLabel}" data-yval="${p[yKey]}"></circle>`;
    }
  }

  let countryDots = "";
  if (showCountry) {
    for (const c of COUNTRIES) {
      const x = gx(c[xKey]);
      const y = gy(c[yKey]);
      const countryZh = COUNTRY_NAME_ZH[c.country] || c.country;
      const nAttr = c.n ? ` data-n="${c.n}"` : "";
      countryDots += `<circle class="country-dot dot-click" cx="${x}" cy="${y}" r="5"
        data-title="${countryZh}"${nAttr} data-xdim="${xKey}" data-xlabel="${xLabel}" data-xval="${c[xKey]}" data-ydim="${yKey}" data-ylabel="${yLabel}" data-yval="${c[yKey]}"></circle>`;
    }
  }

  let otherDots = "";
  if (showAll && otherPoints && otherPoints.length) {
    for (const r of otherPoints) {
      const x = gx(r[xKey]);
      const y = gy(r[yKey]);
      const label = r.nickname || "匿名";
      otherDots += `<circle class="dot-click" cx="${x}" cy="${y}" r="4" fill="#3B5BA5" opacity="0.55"
        data-title="${label}" data-xdim="${xKey}" data-xlabel="${xLabel}" data-xval="${r[xKey]}" data-ydim="${yKey}" data-ylabel="${yLabel}" data-yval="${r[yKey]}"></circle>`;
    }
  }

  let meMark = "";
  if (myPoint) {
    const x = gx(myPoint[xKey]);
    const y = gy(myPoint[yKey]);
    meMark = `
      <line class="me-cross" x1="${x - 10}" y1="${y}" x2="${x + 10}" y2="${y}"/>
      <line class="me-cross" x1="${x}" y1="${y - 10}" x2="${x}" y2="${y + 10}"/>
      <circle class="me-dot dot-click" cx="${x}" cy="${y}" r="7"
        data-title="你" data-xdim="${xKey}" data-xlabel="${xLabel}" data-xval="${myPoint[xKey]}" data-ydim="${yKey}" data-ylabel="${yLabel}" data-yval="${myPoint[yKey]}"></circle>
    `;
  }

  let poleText = "";
  if (poleLabels) {
    const { left, right, top, bottom } = poleLabels;
    const midX = MARGIN.left + PLOT / 2;
    const midY = MARGIN.top + PLOT / 2;
    poleText += `<text class="pole-label" x="${midX}" y="${MARGIN.top - 14}" text-anchor="middle">${top}</text>`;
    poleText += `<text class="pole-label" x="${midX}" y="${h - 12}" text-anchor="middle">${bottom}</text>`;
    poleText += `<text class="pole-label" x="${14}" y="${midY}" text-anchor="start">${left}</text>`;
    poleText += `<text class="pole-label" x="${w - 14}" y="${midY}" text-anchor="end">${right}</text>`;
  }

  return `
    <svg class="chart" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
      ${gridLines}
      ${poleText}
      ${countryDots}
      ${partyDots}
      ${otherDots}
      ${meMark}
    </svg>
  `;
}

function drawCharts() {
  hidePopover();

  document.getElementById("chart-eqli").innerHTML = buildChartSVG({
    xKey: "equality", yKey: "liberty", xLabel: "經濟", yLabel: "社會",
    poleLabels: { left: "市場", right: "平等", top: "自由", bottom: "威權" },
    myPoint: scores, otherPoints: historyResults,
    showParty: chartMode.eqli.party, showCountry: chartMode.eqli.country, showAll: chartMode.eqli.all,
  });
  document.getElementById("chart-indem").innerHTML = buildChartSVG({
    xKey: "individual", yKey: "democracy", xLabel: "個人選擇", yLabel: "政治體制",
    poleLabels: { left: "傳統", right: "進步", top: "民主", bottom: "威權" },
    myPoint: scores, otherPoints: historyResults,
    showParty: chartMode.indem.party, showCountry: chartMode.indem.country, showAll: chartMode.indem.all,
  });
}

// ---------------------------------------------------------------
// Click-to-open popover for chart dots (speech-bubble style)
// ---------------------------------------------------------------
const popover = document.getElementById("dot-popover");
const popoverTitle = popover.querySelector(".dot-popover-title");
const popoverBody = popover.querySelector(".dot-popover-body");

function showDotPopover(targetEl) {
  const title = targetEl.getAttribute("data-title");
  const n = targetEl.getAttribute("data-n");
  const xDim = targetEl.getAttribute("data-xdim");
  const xLabel = targetEl.getAttribute("data-xlabel");
  const xVal = targetEl.getAttribute("data-xval");
  const yDim = targetEl.getAttribute("data-ydim");
  const yLabel = targetEl.getAttribute("data-ylabel");
  const yVal = targetEl.getAttribute("data-yval");

  const xTier = getTierLabel(xDim, Number(xVal));
  const yTier = getTierLabel(yDim, Number(yVal));

  popoverTitle.textContent = title;
  const nRow = n ? `<div class="dot-popover-n">N=${n}</div>` : "";
  popoverBody.innerHTML = `
    ${nRow}
    <div class="dot-popover-row"><span>${xLabel}</span><strong>${xVal}<span class="dot-popover-tier">(${xTier})</span></strong></div>
    <div class="dot-popover-row"><span>${yLabel}</span><strong>${yVal}<span class="dot-popover-tier">(${yTier})</span></strong></div>
  `;
  positionPopover(targetEl);
}

function showInfoPopover(targetEl) {
  const title = targetEl.getAttribute("data-info-title");
  const body = targetEl.getAttribute("data-info-body");
  popoverTitle.textContent = title;
  popoverBody.innerHTML = `<p class="dot-popover-text">${body}</p>`;
  positionPopover(targetEl);
}

function positionPopover(targetEl) {
  popover.classList.remove("hidden");
  // measure after making visible (but keep 0 opacity handled by CSS class if needed)
  const rect = targetEl.getBoundingClientRect();
  const pw = popover.offsetWidth;
  const ph = popover.offsetHeight;
  let left = rect.left + rect.width / 2 - pw / 2;
  let top = rect.top - ph - 12;
  let arrowSide = "bottom"; // triangle points down toward the dot by default

  // clamp horizontally within viewport
  const margin = 8;
  if (left < margin) left = margin;
  if (left + pw > window.innerWidth - margin) left = window.innerWidth - margin - pw;

  // if not enough room above, place below the dot instead
  if (top < margin) {
    top = rect.bottom + 12;
    arrowSide = "top";
  }

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;

  // position the arrow to point at the target's actual x position
  const arrowLeft = rect.left + rect.width / 2 - left;
  popover.style.setProperty("--arrow-left", `${arrowLeft}px`);
  popover.classList.toggle("arrow-top", arrowSide === "top");
  popover.classList.toggle("arrow-bottom", arrowSide === "bottom");
}

function hidePopover() {
  popover.classList.add("hidden");
}

document.addEventListener("click", (e) => {
  const dot = e.target.closest(".dot-click");
  const infoBtn = e.target.closest(".info-btn");
  if (dot) {
    showDotPopover(dot);
  } else if (infoBtn) {
    showInfoPopover(infoBtn);
  } else if (!e.target.closest("#dot-popover")) {
    hidePopover();
  }
});
window.addEventListener("resize", hidePopover);
window.addEventListener("scroll", hidePopover, true);

async function refreshHistoryAndDraw() {
  drawCharts(); // draw immediately with "mine" mode, don't block on network
  try {
    const { data, error } = await supabase
      .from("quiz_results")
      .select("equality,liberty,democracy,individual,nickname")
      .order("created_at", { ascending: false })
      .limit(500);
    if (!error && data) {
      historyResults = data;
      drawCharts();
    }
  } catch (e) {
    // silently ignore — charts still work in "mine" mode
    console.warn("無法讀取歷史結果", e);
  }
}

document.querySelectorAll(".toggle-group[data-chart]").forEach((group) => {
  group.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const chart = group.getAttribute("data-chart");
      const mode = btn.getAttribute("data-mode");
      chartMode[chart][mode] = !chartMode[chart][mode];
      btn.classList.toggle("active", chartMode[chart][mode]);
      drawCharts();
    });
  });
});

// ---------------------------------------------------------------
// Save to Supabase
// ---------------------------------------------------------------
const saveBtn = document.getElementById("save-btn");
const statusMsg = document.getElementById("save-status");
const nicknameInput = document.getElementById("nickname-input");

saveBtn.addEventListener("click", async () => {
  saveBtn.disabled = true;
  statusMsg.textContent = "儲存中…";
  statusMsg.className = "status-msg";
  try {
    const nickname = nicknameInput.value.trim() || null;
    const { data, error } = await supabase
      .from("quiz_results")
      .insert([{ ...scores, nickname }])
      .select()
      .single();
    if (error) throw error;

    // best-effort: store raw answers privately (insert-only table)
    try {
      await supabase.from("quiz_answers_private").insert([{ result_id: data.id, answers }]);
    } catch (e) {
      console.warn("原始作答儲存失敗(不影響主要結果)", e);
    }

    statusMsg.textContent = "已儲存！感謝你的填答。";
    statusMsg.className = "status-msg ok";
    saveBtn.textContent = "已儲存";
    await refreshHistoryAndDraw();
  } catch (e) {
    console.error(e);
    statusMsg.textContent = "儲存失敗,請確認 config.js 是否已填入你的 Supabase 專案資訊。";
    statusMsg.className = "status-msg err";
    saveBtn.disabled = false;
  }
});
