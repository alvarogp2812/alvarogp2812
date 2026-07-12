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
