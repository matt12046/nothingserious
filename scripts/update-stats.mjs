// Fetches Lance Stroll's career stats from Jolpica (the Ergast API replacement)
// and bakes them into index.html: the stroll-stats JSON block, the visible
// numbers, the FAQ answers, the title and descriptions, and the structured data.
// Also bumps the sitemap's lastmod date.
// Run weekly by .github/workflows/update-stats.yml, so visitors never hit the API
// and search engines see real numbers in the raw HTML.
//
// Usage: node scripts/update-stats.mjs            fetch fresh stats, then bake them in
//        node scripts/update-stats.mjs --no-fetch re-bake the stats already in the JSON block

import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://api.jolpi.ca/ergast/f1/drivers/stroll';
const SITE = 'https://didstrollwin.com/';
const PAGE = new URL('../index.html', import.meta.url);
const SITEMAP = new URL('../sitemap.xml', import.meta.url);
const STATS_BLOCK = /(<script id="stroll-stats" type="application\/json">)([\s\S]*?)(<\/script>)/;
const LD_BLOCK = /(<script id="structured-data" type="application\/ld\+json">)[\s\S]*?(<\/script>)/;

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
async function getQualifying() {
    let q1Knockouts = 0;
    let sessions = 0;
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
        const json = await getJson(`${API}/qualifying.json?limit=100&offset=${offset}`);
        total = parseInt(json.MRData.total);
        const races = json.MRData.RaceTable.Races;
        if (Number.isNaN(total) || races.length === 0) break;
        for (const race of races) {
            const result = race.QualifyingResults[0];
            if (!result) continue;
            sessions++;
            if (!result.Q2) q1Knockouts++;
        }
        offset += races.length;
    }
    return { q1Knockouts, qualifyingSessions: sessions };
}

async function fetchStats() {
    const starts = await getTotal('results.json');
    const wins = await getTotal('results/1.json');
    const p2 = await getTotal('results/2.json');
    const p3 = await getTotal('results/3.json');
    const poles = await getTotal('qualifying/1.json');
    const { q1Knockouts, qualifyingSessions } = await getQualifying();

    // Refuse to overwrite good numbers with obviously broken ones
    if (starts < 150) throw new Error(`Suspicious starts count: ${starts}`);
    if (qualifyingSessions < 150) throw new Error(`Suspicious qualifying count: ${qualifyingSessions}`);

    return {
        starts,
        wins,
        p2,
        p3,
        podiums: wins + p2 + p3,
        poles,
        q1Knockouts,
        qualifyingSessions,
        updated: new Date().toISOString().slice(0, 10),
    };
}

const escapeHtml = text => String(text)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const times = n => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const asOf = updated => new Date(`${updated}T00:00:00Z`)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function title({ wins }) {
    return `Has Lance Stroll Ever Won an F1 Race? ${wins === 0 ? '(No.)' : '(Yes?!)'}`;
}

function describe({ starts, wins, podiums, q1Knockouts, updated }) {
    const answer = wins === 0
        ? 'No. Lance Stroll has never won an F1 race:'
        : 'Yes, somehow. Lance Stroll has won an F1 race:';
    return `${answer} ${wins} win${wins === 1 ? '' : 's'} from ${starts} Grand Prix starts as of ${asOf(updated)}, `
        + `plus ${podiums} podiums and ${q1Knockouts} Q1 knockouts. Updated weekly.`;
}

// Questions people actually search, answered from the live numbers
function faq(stats) {
    const { starts, wins, p2, p3, podiums, poles, q1Knockouts, qualifyingSessions, updated } = stats;

    let bestFinish;
    if (wins > 0) bestFinish = `1st. He has won ${times(wins)}. We're as surprised as you are.`;
    else if (p2 > 0) bestFinish = `2nd place, ${times(p2)}. He has ${podiums} career podiums but has never won.`;
    else if (p3 > 0) bestFinish = `3rd place, which he has managed ${times(p3)}. He has never finished higher than 3rd.`;
    else bestFinish = 'He has never finished on the podium.';

    let pole;
    if (poles === 0) pole = 'No.';
    else if (poles === 1) pole = 'Yes, once: the 2020 Turkish Grand Prix, in the rain. It remains the highlight.';
    else pole = `Yes, ${times(poles)}. The first was the 2020 Turkish Grand Prix, in the rain.`;

    const q1Share = Math.round((100 * q1Knockouts) / qualifyingSessions);

    return [
        {
            question: 'Has Lance Stroll ever won an F1 race?',
            answer: wins === 0
                ? `No. Lance Stroll has never won a Formula 1 race: 0 wins from ${starts} Grand Prix starts, as of ${asOf(updated)}.`
                : `Yes, somehow. Lance Stroll has ${wins} Formula 1 win${wins === 1 ? '' : 's'} from ${starts} Grand Prix starts.`,
        },
        { question: "What is Lance Stroll's best F1 finish?", answer: bestFinish },
        { question: 'Has Lance Stroll ever been on pole position?', answer: pole },
        {
            question: 'How often does Lance Stroll get knocked out in Q1?',
            answer: `${q1Knockouts} times in ${qualifyingSessions} qualifying sessions, or about ${q1Share}% of the time.`,
        },
        {
            question: 'Will Lance Stroll ever win an F1 race?',
            answer: "Nobody knows. This page checks every week, so if it ever happens, you'll hear it here first.",
        },
    ];
}

function structuredData(stats, items) {
    const data = {
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'WebPage',
                '@id': SITE,
                url: SITE,
                name: title(stats),
                description: describe(stats),
                dateModified: stats.updated,
                about: {
                    '@type': 'Person',
                    name: 'Lance Stroll',
                    sameAs: ['https://en.wikipedia.org/wiki/Lance_Stroll'],
                },
            },
            {
                '@type': 'FAQPage',
                mainEntity: items.map(({ question, answer }) => ({
                    '@type': 'Question',
                    name: question,
                    acceptedAnswer: { '@type': 'Answer', text: answer },
                })),
            },
        ],
    };
    // Escape "<" so the JSON can never close its own <script> tag
    return JSON.stringify(data).replaceAll('<', '\\u003c');
}

// Replace the text inside the element with the given id, e.g. <span id="x">old</span>
function setText(html, id, text) {
    const pattern = new RegExp(`(<(\\w+) id="${id}"[^>]*>)[^<]*(</\\2>)`);
    if (!pattern.test(html)) throw new Error(`#${id} not found in index.html`);
    return html.replace(pattern, (_, open, tag, close) => `${open}${escapeHtml(text)}${close}`);
}

function setMetaContent(html, attr, text) {
    const pattern = new RegExp(`(<meta ${attr} content=")[^"]*(")`);
    if (!pattern.test(html)) throw new Error(`<meta ${attr}> not found in index.html`);
    return html.replace(pattern, (_, open, close) => `${open}${escapeHtml(text)}${close}`);
}

function applyStats(html, stats) {
    const required = ['starts', 'wins', 'p2', 'p3', 'podiums', 'poles', 'q1Knockouts', 'qualifyingSessions', 'updated'];
    const missing = required.filter(key => stats[key] === undefined);
    if (missing.length) throw new Error(`Stats are missing ${missing.join(', ')}; run without --no-fetch`);

    html = html.replace(STATS_BLOCK, (_, open, __, close) => `${open}${JSON.stringify(stats)}${close}`);

    html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title(stats))}</title>`);
    html = setMetaContent(html, 'property="og:title"', title(stats));
    html = setMetaContent(html, 'name="description"', describe(stats));
    html = setMetaContent(html, 'property="og:description"', describe(stats));

    html = setText(html, 'current-year', stats.updated.slice(0, 4));
    html = setText(html, 'win-counter', stats.wins);
    html = setText(html, 'starts-counter', stats.starts);
    html = setText(html, 'podium-counter', stats.podiums);
    html = setText(html, 'q1-counter', stats.q1Knockouts);
    html = setText(html, 'stats-updated', `Stats last checked ${stats.updated}`);

    const items = faq(stats);
    items.forEach(({ question, answer }, i) => {
        html = setText(html, `faq-q${i + 1}`, question);
        html = setText(html, `faq-a${i + 1}`, answer);
    });

    if (!LD_BLOCK.test(html)) throw new Error('structured-data block not found in index.html');
    html = html.replace(LD_BLOCK, (_, open, close) => `${open}${structuredData(stats, items)}${close}`);
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
