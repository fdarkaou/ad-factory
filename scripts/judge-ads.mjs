#!/usr/bin/env node
// Applies the kill rules from factory.config.json to per-ad insights.
// Usage: node scripts/judge-ads.mjs --insights <ads.json> [--config factory.config.json]
// Input: JSON array of { ad_id, name, status, created_time, spend, conversions }.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DAY_MS = 24 * 60 * 60 * 1000;
const RULE_KEYS = [
  'min_age_days',
  'no_conversion_spend_multiple',
  'high_cpa_spend_multiple',
  'high_cpa_ratio',
  'winner_min_conversions',
  'winner_cpa_ratio',
];

function requireNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

function readRules(config) {
  const targetCpa = requireNumber(config?.targets?.target_cpa, 'targets.target_cpa');
  if (targetCpa === 0) {
    throw new Error('targets.target_cpa must be greater than 0');
  }
  const rules = {};
  for (const key of RULE_KEYS) {
    rules[key] = requireNumber(config?.kill_rules?.[key], `kill_rules.${key}`);
  }
  return { targetCpa, rules };
}

function readAd(row, index) {
  const label = `ads[${index}]`;
  if (typeof row?.ad_id !== 'string' || row.ad_id.length === 0) {
    throw new Error(`${label}.ad_id must be a string`);
  }
  const createdAt = Date.parse(row.created_time);
  if (Number.isNaN(createdAt)) {
    throw new Error(`${label}.created_time must be an ISO date`);
  }
  return {
    ad_id: row.ad_id,
    name: row.name ?? null,
    status: String(row.status ?? '').toUpperCase(),
    createdAt,
    spend: requireNumber(row.spend, `${label}.spend`),
    conversions: requireNumber(row.conversions, `${label}.conversions`),
  };
}

function decide({ ad, targetCpa, rules, now }) {
  const cpa = ad.conversions > 0 ? ad.spend / ad.conversions : null;
  const ageDays = (now.getTime() - ad.createdAt) / DAY_MS;
  const base = { ad_id: ad.ad_id, name: ad.name, spend: ad.spend, conversions: ad.conversions, cpa };

  if (ad.status !== 'ACTIVE') {
    return { ...base, verdict: 'skip', rule: 'not_active' };
  }
  if (ageDays < rules.min_age_days) {
    return { ...base, verdict: 'learning', rule: 'min_age_days' };
  }
  if (ad.conversions === 0 && ad.spend >= rules.no_conversion_spend_multiple * targetCpa) {
    return { ...base, verdict: 'pause', rule: 'no_conversions' };
  }
  const isHighCpa = cpa !== null && cpa > rules.high_cpa_ratio * targetCpa;
  if (isHighCpa && ad.spend >= rules.high_cpa_spend_multiple * targetCpa) {
    return { ...base, verdict: 'pause', rule: 'cpa_too_high' };
  }
  const isWinner =
    ad.conversions >= rules.winner_min_conversions && cpa <= rules.winner_cpa_ratio * targetCpa;
  if (isWinner) {
    return { ...base, verdict: 'winner', rule: 'winner' };
  }
  return { ...base, verdict: 'keep', rule: 'no_threshold_hit' };
}

export function judgeAds({ ads, config, now = new Date() }) {
  if (!Array.isArray(ads)) {
    throw new Error('ads must be an array');
  }
  const { targetCpa, rules } = readRules(config);
  return ads.map((row, index) => decide({ ad: readAd(row, index), targetCpa, rules, now }));
}

function readFlag(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return fallback;
  }
  return argv[index + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  const insightsPath = readFlag(argv, '--insights');
  if (!insightsPath) {
    process.stderr.write('Usage: node scripts/judge-ads.mjs --insights <ads.json> [--config <path>]\n');
    process.exitCode = 2;
    return;
  }
  try {
    const configPath = readFlag(argv, '--config', 'factory.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const ads = JSON.parse(await readFile(insightsPath, 'utf8'));
    process.stdout.write(`${JSON.stringify(judgeAds({ ads, config }), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`judge-ads: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
