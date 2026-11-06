#!/usr/bin/env node
/**
 * Fetch the latest CN ARAM: Mayhem champion stats from Tencent 101.
 *
 * Source: https://101.qq.com/#/rankings/hextech
 * Endpoint used by that page:
 *   https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_hero_rank_v2?dtstatdate=YYYYMMDD
 *
 * Outputs:
 *   data/latest.json
 *   data/manifest.json
 *
 * No third-party npm dependencies; requires Node 18+ (global fetch).
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA_DIR = join(ROOT, 'data');

const ENDPOINT = 'https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_hero_rank_v2';
const PAGE_URL = 'https://101.qq.com/#/rankings/hextech';
const EXPECTED_ROWS = 173;

function shanghaiDate(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}${get('month')}${get('day')}`;
}

function toRate(value) {
  const n = Number.parseFloat(String(value));
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`Invalid rate: ${value}`);
  }
  return Math.round(n * 1_000_000) / 1_000_000;
}

function parseRows(list) {
  if (!list) return [];
  const rows = list.split('#').filter(Boolean).map((raw) => {
    const p = raw.split('_');
    if (p.length < 6) throw new Error(`Malformed row: ${raw.slice(0, 80)}`);
    const championId = Number.parseInt(p[0], 10);
    const rank = Number.parseInt(p[1], 10);
    if (!Number.isInteger(championId) || championId <= 0) {
      throw new Error(`Invalid championId: ${p[0]}`);
    }
    if (!Number.isInteger(rank) || rank <= 0) {
      throw new Error(`Invalid rank: ${p[1]}`);
    }

    const topPartners = (p[5] || '')
      .split('&')
      .slice(0, 3)
      .map((item) => {
        const [id, pickRate, winRate, partnerRank] = item.split(',');
        return {
          championId: Number.parseInt(id, 10),
          pickRate: Number.parseFloat(pickRate),
          winRate: Number.parseFloat(winRate),
          rank: Number.parseInt(partnerRank, 10),
        };
      })
      .filter((x) => Number.isInteger(x.championId) && x.championId > 0);

    const items = (p[10] || '')
      .split(',')
      .map((x) => Number.parseInt(x, 10))
      .filter((x) => Number.isInteger(x) && x > 0);

    return {
      championId,
      rank,
      rankChange: p[2] || '',
      winRate: toRate(p[3]),
      pickRate: toRate(p[4]),
      topPartners,
      items,
    };
  });

  const unique = new Set(rows.map((r) => r.championId));
  if (rows.length !== EXPECTED_ROWS || unique.size !== EXPECTED_ROWS) {
    throw new Error(`Unexpected row count: ${rows.length}, unique: ${unique.size}`);
  }
  return rows;
}

async function fetchForDate(date) {
  const url = `${ENDPOINT}?dtstatdate=${date}`;
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      referer: 'https://101.qq.com/',
      origin: 'https://101.qq.com',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const text = await res.text();
  if (!text.trim()) return null;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    // 101 sometimes returns an empty/partial body before the daily publish.
    return null;
  }
  if (payload?.code !== 0) {
    throw new Error(`101 API error: ${payload?.message || payload?.msg || 'unknown'}`);
  }
  const bucket = payload?.data?._fieldValues;
  const key = bucket && Object.keys(bucket)[0];
  if (!key) return null;
  let inner;
  try {
    inner = JSON.parse(bucket[key]);
  } catch {
    // 101 returns an empty string for a date that is not published yet.
    return null;
  }
  const list = inner?.listcollect;
  if (!list) return null;
  const champions = parseRows(list);
  return { date, champions };
}

async function main() {
  let result = null;
  let lastError = null;

  // 101 publishes by day; today may be empty before the daily update.
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = shanghaiDate(offset);
    try {
      const candidate = await fetchForDate(date);
      if (candidate) {
        result = candidate;
        console.log(`[101] using ${date}: ${candidate.champions.length} champions`);
        break;
      }
      console.log(`[101] ${date}: no data yet`);
    } catch (error) {
      lastError = error;
      console.warn(`[101] ${date}: ${error.message}`);
    }
  }

  if (!result) {
    throw new Error(`No usable 101 data in the last 8 days. Last error: ${lastError?.message || 'none'}`);
  }

  const payload = {
    schema: 1,
    source: '101.qq.com',
    sourceUrl: PAGE_URL,
    endpoint: ENDPOINT,
    region: 'CN',
    date: result.date,
    fetchedAt: new Date().toISOString(),
    count: result.champions.length,
    champions: result.champions,
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const hash = createHash('sha256').update(json).digest('hex');

  const manifest = {
    schema: 1,
    source: payload.source,
    region: payload.region,
    date: payload.date,
    count: payload.count,
    sha256: hash,
    bytes: Buffer.byteLength(json),
    generatedAt: payload.fetchedAt,
    latest: 'data/latest.json',
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, 'latest.json'), json, 'utf8');
  await writeFile(join(DATA_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[101] wrote ${payload.count} champions, ${manifest.bytes} bytes, sha256 ${hash}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
