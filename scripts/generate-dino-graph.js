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

  const marginX = 8;
  const gridTop = 10;
  const gridHeight = ROWS * STEP - GAP;
  const trackY = gridTop + gridHeight + 50; // baseline for the dino/cacti, extra room for a bigger sprite
  const width = marginX * 2 + COLS * STEP - GAP;
  const height = trackY + 14;

  // --- heatmap grid ---
  let gridSvg = "";
  weeks.forEach((w, wi) => {
    w.contributionDays.forEach((d) => {
      const x = marginX + wi * STEP;
      const y = gridTop + d.weekday * STEP;
      gridSvg += `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${theme.grid[d.level]}"/>\n`;
    });
  });

  // --- obstacles: only the standout weeks (level >= 3), spaced apart so
  // they never crowd each other. This keeps the track readable instead of
  // a wall of cacti. ---
  const trackWidth = COLS * STEP - GAP;
  const MIN_GAP_PX = Math.max(36, trackWidth * 0.045); // minimum distance between two cacti
  const MAX_OBSTACLES = 12;

  const candidates = [];
  weeks.forEach((w, wi) => {
    const maxLevel = Math.max(...w.contributionDays.map((d) => d.level));
    if (maxLevel >= 3) {
      candidates.push({ x: marginX + wi * STEP + CELL / 2, level: maxLevel });
    }
  });

  // Greedily keep the strongest weeks, enforcing minimum spacing.
  candidates.sort((a, b) => b.level - a.level || a.x - b.x);
  const chosen = [];
  for (const c of candidates) {
    if (chosen.length >= MAX_OBSTACLES) break;
    if (chosen.every((o) => Math.abs(o.x - c.x) >= MIN_GAP_PX)) chosen.push(c);
  }
  const sampledObstacles = chosen.sort((a, b) => a.x - b.x);

  // --- classic saguaro-style cactus, one or two arms depending on level ---
  let cactusSvg = "";
  sampledObstacles.forEach((o) => {
    const h = 20 + (o.level - 3) * 8; // level 3 -> 20px, level 4 -> 28px
    const stemW = 6;
    const armW = 5;
    const twoArms = o.level >= 4;
    cactusSvg += `
      <g transform="translate(${o.x}, ${trackY - h})" fill="${theme.cactus}">
        <rect x="${-stemW / 2}" y="0" width="${stemW}" height="${h}" rx="2.5"/>
        <rect x="${-stemW / 2 - armW}" y="${h * 0.32}" width="${armW}" height="${armW * 1.6}" rx="2"/>
        <rect x="${-stemW / 2 - armW}" y="${h * 0.32 - armW * 1.4}" width="2.4" height="${armW * 1.4 + 2}" rx="1.2"/>
        ${
          twoArms
            ? `<rect x="${stemW / 2}" y="${h * 0.5}" width="${armW}" height="${armW * 1.6}" rx="2"/>
               <rect x="${stemW / 2 + armW - 2.4}" y="${h * 0.5 - armW * 1.3}" width="2.4" height="${armW * 1.3 + 2}" rx="1.2"/>`
            : ""
        }
      </g>`;
  });

  const totalDuration = Math.max(10, Math.round(COLS * 0.4)); // seconds, one lap

  // --- jump keyframes synced to obstacle positions ---
  const jumpHeight = 26;
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

  // --- dino sprite: a single silhouette path (body/head/tail), an eye
  // punched out, and two alternating leg shapes for a running gait. ---
  const eyeColor = theme.bg === "transparent" ? (theme === THEMES.dark ? "#0d1117" : "#ffffff") : theme.bg;

  const dinoBody = `
    M 4 34
    L 4 22
    C 4 16 8 12 14 12
    L 14 6
    C 14 3 16 1 19 1
    C 21 1 22 2 22 4
    L 22 12
    L 30 12
    C 33 12 35 14 35 17
    L 35 20
    L 39 20
    L 39 24
    L 35 24
    L 35 30
    C 35 32 34 34 32 34
    L 27 34
    L 27 27
    L 15 27
    L 15 34
    Z`;

  const dino = `
    <g id="dino" transform="translate(0,${trackY - 40})">
      <g fill="${theme.dino}">
        <path d="${dinoBody}"/>
        <circle cx="27" cy="8" r="1.6" fill="${eyeColor}"/>
        <g>
          <path d="M 12 34 L 12 40 L 17 40 L 17 36 Z">
            <animate attributeName="d" dur="0.3s" repeatCount="indefinite"
              values="M 12 34 L 12 40 L 17 40 L 17 36 Z;
                      M 12 34 L 10 39 L 15 40 L 17 35 Z;
                      M 12 34 L 12 40 L 17 40 L 17 36 Z"/>
          </path>
          <path d="M 22 34 L 20 40 L 25 40 L 25 34 Z">
            <animate attributeName="d" dur="0.3s" repeatCount="indefinite"
              values="M 22 34 L 20 40 L 25 40 L 25 34 Z;
                      M 22 34 L 22 40 L 27 40 L 27 36 Z;
                      M 22 34 L 20 40 L 25 40 L 25 34 Z"/>
          </path>
        </g>
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
