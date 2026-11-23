/**
 * Pool the difficulty figures from several soak runs and set groups of runs side by side,
 * for a before/after comparison. Single runs vary a lot (a pilot that survives one long
 * life and one that dies twice early are both fifteen minutes), so compare pooled figures
 * from several runs, not one run against another.
 *
 *   node .github/tools/soak.mjs --pilot person --tag before-1 --page old.html   (and -2, -3 ...)
 *   node .github/tools/soak.mjs --pilot person --tag after-1                    (and -2, -3 ...)
 *   node .github/tools/figures.mjs before after
 *
 * Each argument is a tag prefix: it pools .github/tools/out/soak-<prefix>.json and every
 * soak-<prefix>-*.json. Rates are pooled (total kills over total minutes, total hits over
 * total rounds); the time to first kill is bimodal, so it is given as the share of lives
 * that made one inside 10 s. Runs that recorded it also give where the fight was: the
 * range of the runs' median altitude, the highest point, and the share of time above 5 km.
 * Kills per minute also gets the mean of the runs with its standard error (the spread of
 * the runs over the square root of how many): two groups whose means are within about two
 * standard errors of the difference have not been told apart. Four runs a side told apart
 * nothing smaller than a factor of two; use eight or more.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OUT } from './lib.mjs';

const groups = process.argv.slice(2);
if (!groups.length) { console.error('usage: figures.mjs <tag prefix> [<tag prefix> ...]'); process.exit(2); }
const files = await readdir(OUT).catch(() => []);
const median = a => { a = [...a].sort((x, y) => x - y); const n = a.length;
  return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : null; };

const cols = [];
for (const g of groups) {
  const mine = files.filter(f => f === `soak-${g}.json` || (f.startsWith(`soak-${g}-`) && f.endsWith('.json')));
  if (!mine.length) { console.error(`no soak-${g}*.json in ${OUT}`); process.exit(1); }
  const runs = await Promise.all(mine.map(async f => JSON.parse(await readFile(join(OUT, f), 'utf8'))));
  const lives = runs.flatMap(r => r.lifeDetail), sum = k => lives.reduce((n, l) => n + l[k], 0);
  const minutes = runs.reduce((n, r) => n + r.gameMinutes, 0);
  const rounds = runs.reduce((n, r) => n + r.rounds, 0), hits = runs.reduce((n, r) => n + r.hits, 0);
  const missiles = sum('missiles'), unguided = sum('unguided'), gun = sum('gun'), missile = sum('missile');
  const firsts = lives.map(l => l.firstKill).filter(t => t !== null);
  const kpm = runs.map(r => r.killsPerMin), gpm = runs.map(r => r.gunKillsPerMin);
  const meanSe = a => { const m = a.reduce((x, y) => x + y, 0) / a.length;
    const se = a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1) / a.length) : NaN;
    return `${m.toFixed(2)} ± ${se.toFixed(2)}`; };
  const waves = [], alts = runs.map(r => r.altitudeM).filter(a => a && a.samples);
  for (const r of runs) for (const w of r.deathsPerWave) {
    const c = waves[w.wave - 1] ||= { died: 0, reached: 0 }; c.died += w.died; c.reached += w.reached; }
  cols.push({ name: g, rows: {
    'runs, pilot': `${runs.length}, ${[...new Set(runs.map(r => r.pilot))].join('/')}`,
    'game-minutes alive': minutes.toFixed(1),
    'lives': String(lives.length),
    // Bimodal (a kill inside 10 s, or a wait of 12-60 s), so the share, not a median.
    'first kill inside 10 s': `${firsts.filter(t => t <= 10).length} of ${lives.length} lives`,
    'lives without a kill': `${lives.length - firsts.length} of ${lives.length}`,
    'kills per minute': `${((gun + missile) / minutes).toFixed(2)} (runs ${Math.min(...kpm).toFixed(2)}-${Math.max(...kpm).toFixed(2)})`,
    '  mean of runs ± s.e.': meanSe(kpm),
    '  gun': `${(gun / minutes).toFixed(2)} (${gun} kills)`,
    '  gun, mean of runs ± s.e.': meanSe(gpm),
    '  missile': `${(missile / minutes).toFixed(2)} (${missile} kills)`,
    'hits per round fired': `${(100 * hits / Math.max(rounds, 1)).toFixed(2)}% (${hits}/${rounds})`,
    'missiles fired': String(missiles),
    '  without a lock': `${unguided} (${(100 * unguided / Math.max(missiles, 1)).toFixed(0)}%)`,
    ...Object.fromEntries(waves.map((w, i) => [`deaths on wave ${i + 1}`, `${w.died} of ${w.reached}`])),
    ...(alts.length ? {
      'altitude median, km (runs)': `${(Math.min(...alts.map(a => a.p50)) / 1000).toFixed(1)}-${(Math.max(...alts.map(a => a.p50)) / 1000).toFixed(1)}`,
      'altitude highest, km': (Math.max(...alts.map(a => a.max)) / 1000).toFixed(1),
      'time above 5 km': `${(100 * alts.reduce((n, a) => n + a.over5km, 0) / alts.length).toFixed(0)}%`,
      'ground deaths': String(runs.reduce((n, r) => n + r.deathsPerWave.reduce((m, w) => m + (w.ground || 0), 0), 0)) } : {}),
  } });
}
const keys = [...new Set(cols.flatMap(c => Object.keys(c.rows)))];
const width = [Math.max(...keys.map(k => k.length)), ...cols.map(c => Math.max(c.name.length, ...keys.map(k => (c.rows[k] || '-').length)))];
const line = cells => '| ' + cells.map((c, i) => c.padEnd(width[i])).join(' | ') + ' |';
console.log(line(['', ...cols.map(c => c.name)]));
console.log('|' + width.map(w => '-'.repeat(w + 2)).join('|') + '|');
for (const k of keys) console.log(line([k, ...cols.map(c => c.rows[k] || '-')]));
