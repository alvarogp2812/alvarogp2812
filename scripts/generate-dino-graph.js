#!/usr/bin/env node
/**
 * generate-dino-graph.js
 *
 * Turns a GitHub user's contribution calendar into an animated SVG of the
 * Chrome "offline dinosaur" (T-Rex Runner) game: the dino runs across the
 * track and jumps over cacti placed on weeks with high contribution activity.
 *
 * Usage:
 *   GITHUB_TOKEN=xxx node generate-dino-graph.js <github_username> <output_dir>
 *
 * Produces:
 *   <output_dir>/dino-contribution-graph.svg
 *   <output_dir>/dino-contribution-graph-dark.svg
 */

const fs = require("fs");
const path = require("path");

const USERNAME = process.argv[2] || process.env.GITHUB_USER_NAME;
const OUT_DIR = process.argv[3] || "dist";
const TOKEN = process.env.GITHUB_TOKEN;

if (!USERNAME) {
  console.error("Usage: node generate-dino-graph.js <github_username> <output_dir>");
  process.exit(1);
}

// ---------- 1. Fetch contribution calendar ----------

async function fetchContributionCalendar(username) {
  const query = `
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            weeks {
              contributionDays {
                contributionCount
                weekday
                date
              }
            }
          }
        }
      }
    }
  `;

  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { login: username } }),
  });

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  return json.data.user.contributionsCollection.contributionCalendar.weeks;
}

// Assigns a 0-4 quartile level per day, relative to this user's own max count
// (mirrors how GitHub buckets NONE/FIRST_QUARTILE/.../FOURTH_QUARTILE).
function levelize(weeks) {
  const counts = weeks.flatMap((w) => w.contributionDays.map((d) => d.contributionCount));
  const max = Math.max(1, ...counts);
  return weeks.map((w) => ({
    contributionDays: w.contributionDays.map((d) => {
      let level = 0;
      if (d.contributionCount > 0) {
        const ratio = d.contributionCount / max;
        if (ratio > 0.75) level = 4;
        else if (ratio > 0.5) level = 3;
        else if (ratio > 0.25) level = 2;
        else level = 1;
      }
      return { ...d, level };
    }),
  }));
}

// ---------- 2. Build the SVG ----------

const THEMES = {
  light: {
    bg: "transparent",
    grid: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    ground: "#535353",
    dino: "#535353",
    cactus: "#535353",
    text: "#24292f",
  },
  dark: {
    bg: "transparent",
    grid: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
    ground: "#8b949e",
    dino: "#c9d1d9",
    cactus: "#c9d1d9",
    text: "#c9d1d9",
  },
};

function buildSvg(weeks, theme) {
  const CELL = 10;
  const GAP = 3;
  const STEP = CELL + GAP;
  const COLS = weeks.length;
  const ROWS = 7;

  const marginX = 6;
  const gridTop = 6;
  const gridHeight = ROWS * STEP - GAP;
  const trackY = gridTop + gridHeight + 34; // baseline for the dino/cacti
  const width = marginX * 2 + COLS * STEP - GAP;
  const height = trackY + 20;

  // --- heatmap grid ---
  let gridSvg = "";
  weeks.forEach((w, wi) => {
    w.contributionDays.forEach((d) => {
      const x = marginX + wi * STEP;
      const y = gridTop + d.weekday * STEP;
      gridSvg += `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${theme.grid[d.level]}"/>\n`;
    });
  });

  // --- obstacles: one cactus per week whose max day-level is >= 2 ---
  const obstacles = [];
  weeks.forEach((w, wi) => {
    const maxLevel = Math.max(...w.contributionDays.map((d) => d.level));
    if (maxLevel >= 2) {
      const x = marginX + wi * STEP + CELL / 2;
      obstacles.push({ x, level: maxLevel });
    }
  });
  // Cap the number of obstacles so the animation stays readable.
  const MAX_OBSTACLES = 24;
  const sampledObstacles =
    obstacles.length <= MAX_OBSTACLES
      ? obstacles
      : obstacles.filter((_, i) => i % Math.ceil(obstacles.length / MAX_OBSTACLES) === 0);

  let cactusSvg = "";
  sampledObstacles.forEach((o, i) => {
    const h = 10 + o.level * 4;
    const w2 = 5 + o.level * 1.5;
    cactusSvg += `
      <g transform="translate(${o.x - w2 / 2}, ${trackY - h})" fill="${theme.cactus}">
        <rect x="0" y="0" width="${w2}" height="${h}" rx="1.5"/>
        <rect x="${-w2 * 0.6}" y="${h * 0.25}" width="${w2 * 0.6}" height="${Math.max(3, h * 0.28)}" rx="1.5"/>
        <rect x="${w2}" y="${h * 0.4}" width="${w2 * 0.6}" height="${Math.max(3, h * 0.28)}" rx="1.5"/>
      </g>`;
  });

  const trackWidth = COLS * STEP - GAP;
  const totalDuration = Math.max(8, Math.round(COLS * 0.35)); // seconds, one lap

  // --- jump keyframes synced to obstacle positions ---
  const jumpHeight = 16;
  const halfJumpFrac = 0.018; // fraction of the lap spent airborne, per side

  let keyTimes = [0];
  let values = ["0"];

  sampledObstacles.forEach((o) => {
    const tc = (o.x - marginX) / trackWidth;
    let tStart = Math.max(0, tc - halfJumpFrac * 2);
    let tPeak = Math.max(tStart + 0.002, tc - halfJumpFrac * 0.3);
    let tLand = Math.min(0.999, tc + halfJumpFrac * 0.6);
    // keep keyTimes strictly increasing
    if (tStart <= parseFloat(keyTimes[keyTimes.length - 1])) tStart = parseFloat(keyTimes[keyTimes.length - 1]) + 0.001;
    if (tPeak <= tStart) tPeak = tStart + 0.002;
    if (tLand <= tPeak) tLand = tPeak + 0.002;
    keyTimes.push(tStart.toFixed(4), tPeak.toFixed(4), tLand.toFixed(4));
    values.push("0", `-${jumpHeight}`, "0");
  });

  if (parseFloat(keyTimes[keyTimes.length - 1]) < 1) {
    keyTimes.push("1");
    values.push("0");
  }

  // --- dino sprite (simple pixel-style, two-frame running legs) ---
  const dino = `
    <g id="dino" transform="translate(0,${trackY})">
      <g transform="translate(0,-24)" fill="${theme.dino}">
        <rect x="6" y="0" width="16" height="10"/>
        <rect x="14" y="-6" width="10" height="6"/>
        <rect x="20" y="-6" width="4" height="3"/>
        <rect x="0" y="6" width="10" height="10"/>
        <rect x="2" y="16" width="4" height="6">
          <animate attributeName="height" values="6;1;6" keyTimes="0;0.5;1" dur="0.28s" repeatCount="indefinite"/>
        </rect>
        <rect x="10" y="16" width="4" height="6">
          <animate attributeName="height" values="1;6;1" keyTimes="0;0.5;1" dur="0.28s" repeatCount="indefinite"/>
        </rect>
        <rect x="23" y="3" width="3" height="3" fill="${theme.bg === "transparent" ? "#ffffff00" : theme.bg}" opacity="0"/>
      </g>
    </g>`;

  const ground = `<line x1="${marginX}" y1="${trackY}" x2="${marginX + trackWidth}" y2="${trackY}" stroke="${theme.ground}" stroke-width="1.5" stroke-dasharray="4 3"/>`;

  const svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <style>text{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:9px;fill:${theme.text};}</style>
  ${gridSvg}
  ${ground}
  ${cactusSvg}
  <g>
    ${dino}
    <animateTransform attributeName="transform" type="translate" additive="sum"
      values="0,0;${trackWidth},0" dur="${totalDuration}s" repeatCount="indefinite"/>
    <animateTransform attributeName="transform" type="translate" additive="sum"
      values="${values.map((v) => `0,${v}`).join(";")}"
      keyTimes="${keyTimes.join(";")}"
      dur="${totalDuration}s" repeatCount="indefinite"/>
  </g>
</svg>`;

  return svg;
}

// ---------- 3. Run ----------

(async () => {
  try {
    const rawWeeks = await fetchContributionCalendar(USERNAME);
    const weeks = levelize(rawWeeks);

    fs.mkdirSync(OUT_DIR, { recursive: true });

    const lightSvg = buildSvg(weeks, THEMES.light);
    const darkSvg = buildSvg(weeks, THEMES.dark);

    fs.writeFileSync(path.join(OUT_DIR, "dino-contribution-graph.svg"), lightSvg);
    fs.writeFileSync(path.join(OUT_DIR, "dino-contribution-graph-dark.svg"), darkSvg);

    console.log(`Generated dino-contribution-graph.svg and dino-contribution-graph-dark.svg in ${OUT_DIR}/`);
  } catch (err) {
    console.error("Failed to generate dino contribution graph:", err.message);
    process.exit(1);
  }
})();
