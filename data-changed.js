// Чи змінились самі дані постів (а не лише fetched_at) порівняно з останнім комітом.
// Друкує changed=true|false у GITHUB_OUTPUT — workflow за ним запускає перебудову сайту.
// Порівнюємо пост, річку, дату спостереження, рівень, зміну й температуру; історію й службові поля ігноруємо.
const fs = require('fs');
const { execSync } = require('child_process');

const sig = (data) =>
  JSON.stringify(
    Object.values((data && data.rivers) || {})
      .flat()
      .map((p) => [p.river, p.post, p.observed_at, p.water_level_cm, p.delta_24h_cm, p.water_temperature_c])
      .sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`)),
  );

let prev = null;
try {
  prev = JSON.parse(execSync('git show HEAD:all-posts.json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
} catch (e) {}
const next = JSON.parse(fs.readFileSync('all-posts.json', 'utf8'));
const changed = next.ok !== false && sig(prev) !== sig(next);
console.log(`changed=${changed} (постів: було ${prev ? prev.total_posts : '—'}, стало ${next.total_posts})`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
