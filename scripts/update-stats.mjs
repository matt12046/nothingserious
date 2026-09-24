// Fetches Lance Stroll's career stats from Jolpica (the Ergast API replacement)
// and bakes them into the stroll-stats JSON block in index.html.
// Run weekly by .github/workflows/update-stats.yml, so visitors never hit the API.
//
// Usage: node scripts/update-stats.mjs

import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://api.jolpi.ca/ergast/f1/drivers/stroll';
const PAGE = new URL('../index.html', import.meta.url);
const STATS_BLOCK = /(<script id="stroll-stats" type="application\/json">)[\s\S]*?(<\/script>)/;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Jolpica allows 4 requests/second, so space requests out and back off on 429s.
async function getJson(url) {
    for (let attempt = 1; attempt <= 4; attempt++) {
        await sleep(500);
        const res = await fetch(url);
        if (res.status === 429) {
            await sleep(5000 * attempt);
            continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return res.json();
    }
    throw new Error(`Still rate limited after 4 attempts: ${url}`);
}

async function getTotal(path) {
    const json = await getJson(`${API}/${path}?limit=1`);
    const total = parseInt(json.MRData.total);
    if (Number.isNaN(total)) throw new Error(`Bad total for ${path}`);
    return total;
}

// Q1 knockouts: qualifying entries with no Q2 time. There's no total for this,
// so page through every qualifying result (Jolpica caps limit at 100).
async function getQ1Knockouts() {
    let knockouts = 0;
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
        const json = await getJson(`${API}/qualifying.json?limit=100&offset=${offset}`);
        total = parseInt(json.MRData.total);
        const races = json.MRData.RaceTable.Races;
        if (Number.isNaN(total) || races.length === 0) break;
        for (const race of races) {
            const result = race.QualifyingResults[0];
            if (result && !result.Q2) knockouts++;
        }
        offset += races.length;
    }
    return knockouts;
}

const starts = await getTotal('results.json');
const wins = await getTotal('results/1.json');
const podiums = wins + await getTotal('results/2.json') + await getTotal('results/3.json');
const poles = await getTotal('qualifying/1.json');
const q1Knockouts = await getQ1Knockouts();

// Refuse to overwrite good numbers with obviously broken ones
if (starts < 150) throw new Error(`Suspicious starts count: ${starts}`);

const stats = {
    starts,
    wins,
    podiums,
    poles,
    q1Knockouts,
    updated: new Date().toISOString().slice(0, 10),
};

const html = await readFile(PAGE, 'utf8');
if (!STATS_BLOCK.test(html)) throw new Error('stroll-stats block not found in index.html');
await writeFile(PAGE, html.replace(STATS_BLOCK, `$1${JSON.stringify(stats)}$2`));
console.log('Updated stats:', stats);
