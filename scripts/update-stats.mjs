// Fetches Lance Stroll's career stats from Jolpica (the Ergast API replacement)
// and bakes them into index.html: the stroll-stats JSON block, the visible
// numbers, and the meta descriptions. Also bumps the sitemap's lastmod date.
// Run weekly by .github/workflows/update-stats.yml, so visitors never hit the API
// and search engines see real numbers in the raw HTML.
//
// Usage: node scripts/update-stats.mjs            fetch fresh stats, then bake them in
//        node scripts/update-stats.mjs --no-fetch re-bake the stats already in the JSON block

import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://api.jolpi.ca/ergast/f1/drivers/stroll';
const PAGE = new URL('../index.html', import.meta.url);
const SITEMAP = new URL('../sitemap.xml', import.meta.url);
const STATS_BLOCK = /(<script id="stroll-stats" type="application\/json">)([\s\S]*?)(<\/script>)/;

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

async function fetchStats() {
    const starts = await getTotal('results.json');
    const wins = await getTotal('results/1.json');
    const podiums = wins + await getTotal('results/2.json') + await getTotal('results/3.json');
    const poles = await getTotal('qualifying/1.json');
    const q1Knockouts = await getQ1Knockouts();

    // Refuse to overwrite good numbers with obviously broken ones
    if (starts < 150) throw new Error(`Suspicious starts count: ${starts}`);

    return {
        starts,
        wins,
        podiums,
        poles,
        q1Knockouts,
        updated: new Date().toISOString().slice(0, 10),
    };
}

// Replace the text inside the element with the given id, e.g. <span id="x">old</span>
function setText(html, id, text) {
    const pattern = new RegExp(`(<(\\w+) id="${id}"[^>]*>)[^<]*(</\\2>)`);
    if (!pattern.test(html)) throw new Error(`#${id} not found in index.html`);
    return html.replace(pattern, (_, open, tag, close) => `${open}${text}${close}`);
}

function setMetaContent(html, attr, text) {
    const pattern = new RegExp(`(<meta ${attr} content=")[^"]*(")`);
    if (!pattern.test(html)) throw new Error(`<meta ${attr}> not found in index.html`);
    return html.replace(pattern, (_, open, close) => `${open}${text}${close}`);
}

function describe({ starts, wins, podiums, q1Knockouts, updated }) {
    const asOf = new Date(`${updated}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const answer = wins === 0 ? 'No.' : 'YES. Somehow.';
    return `${answer} As of ${asOf}, Lance Stroll has ${wins} F1 wins from ${starts} Grand Prix starts, `
        + `plus ${podiums} podiums and ${q1Knockouts} Q1 knockouts. Updated weekly.`;
}

function applyStats(html, stats) {
    html = html.replace(STATS_BLOCK, (_, open, __, close) => `${open}${JSON.stringify(stats)}${close}`);
    html = setText(html, 'current-year', stats.updated.slice(0, 4));
    html = setText(html, 'win-counter', stats.wins);
    html = setText(html, 'starts-counter', stats.starts);
    html = setText(html, 'podium-counter', stats.podiums);
    html = setText(html, 'q1-counter', stats.q1Knockouts);
    html = html.replace('id="q1-container" class="hidden ', 'id="q1-container" class="flex ');
    html = setText(html, 'stats-updated', `Stats last checked ${stats.updated}`);
    const description = describe(stats);
    html = setMetaContent(html, 'name="description"', description);
    html = setMetaContent(html, 'property="og:description"', description);
    return html;
}

const html = await readFile(PAGE, 'utf8');
const block = html.match(STATS_BLOCK);
if (!block) throw new Error('stroll-stats block not found in index.html');

const stats = process.argv.includes('--no-fetch') ? JSON.parse(block[2]) : await fetchStats();
await writeFile(PAGE, applyStats(html, stats));

const sitemap = await readFile(SITEMAP, 'utf8');
await writeFile(SITEMAP, sitemap.replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${stats.updated}</lastmod>`));

console.log('Updated stats:', stats);
