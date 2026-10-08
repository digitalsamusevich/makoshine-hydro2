// «Черговий» парсера (2026-10-08): один запуск GitHub Actions працює ~5,5 год і сам вирішує, коли збирати дані,
// замість частого cron, який GitHub не тримає (реально ~5 запусків на добу замість заявлених кожні 30 хв;
// 08.10 — жодного запуску з 02:01 до 09:06 UTC). Наприкінці workflow запускає наступну зміну сам
// (workflow_dispatch через вбудований GITHUB_TOKEN — нових секретів не треба), тож ланцюжок безперервний,
// а cron лишився лише запасним «перезапуском», якщо ланцюжок обірвався.
//
// Частота: поки сьогоднішніх (за Києвом) даних немає — кожні 10 хв; коли є — раз на годину (уточнення, температура).
// Коміт — коли дані постів змінились, а без змін — раз на 3 год (fetched_at), щоб health-check бачив, що парсер живий.
// Після коміту зі зміненими даними — деплой-хуки сайтів (SITE_DEPLOY_HOOK, AI_SOFT_DEPLOY_HOOK), якщо задані.
//
// Змінні: LOOP_MINUTES (тривалість циклу, 320), DRY_RUN=1 (без git push і хуків — для локальної перевірки).
const { spawnSync, execSync } = require('child_process');
const fs = require('fs');

const LOOP_MIN = Number(process.env.LOOP_MINUTES || 320);
const DRY = process.env.DRY_RUN === '1';
const FAST_MS = 10 * 60e3;
const SLOW_MS = 60 * 60e3;
const RETRY_MS = 5 * 60e3;
const HEARTBEAT_MS = 3 * 3600e3;
const RAW_CACHE_MS = 5 * 60e3; // raw.githubusercontent.com кешує файл до ~5 хв — хук сайту смикаємо після цього
const COMPLETE_SHARE = 0.9;

const started = Date.now();
const deadline = started + LOOP_MIN * 60e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Та сама сигнатура, що в data-changed.js: пост, річка, дата спостереження, рівень, зміна, температура
const sig = (data) =>
	JSON.stringify(
		Object.values((data && data.rivers) || {})
			.flat()
			.map((p) => [p.river, p.post, p.observed_at, p.water_level_cm, p.delta_24h_cm, p.water_temperature_c])
			.sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`)),
	);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const headJson = (f) => {
	try {
		return JSON.parse(execSync(`git show HEAD:${f}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
	} catch (e) {
		return null;
	}
};
// «08.10.2026» за Києвом — у такому форматі observed_at від УкрГМЦ
const todayKyiv = () =>
	new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());
const todayShare = (data) => {
	const posts = Object.values((data && data.rivers) || {}).flat();
	const t = todayKyiv();
	return posts.length ? posts.filter((p) => String(p.observed_at || '').startsWith(t)).length / posts.length : 0;
};

function scrape() {
	const r = spawnSync('node', ['fetch-makoshine.js'], { stdio: 'inherit', timeout: 15 * 60e3 });
	if (r.status !== 0) log(`Парсер завершився з помилкою (status ${r.status}${r.error ? `, ${r.error.message}` : ''})`);
	return r.status === 0;
}

function commit(message) {
	if (DRY) return log(`[DRY] коміт: ${message}`), true;
	const sh = (c) => execSync(c, { stdio: 'inherit' });
	sh('git add all-posts.json all-history.json marker-cache.json');
	try {
		sh(`git commit -q -m "${message}"`);
	} catch (e) {
		log('Немає змін для коміту');
		return false;
	}
	for (let i = 0; i < 3; i++) {
		try {
			sh('git pull --rebase -q');
			sh('git push -q');
			return true;
		} catch (e) {
			log(`git push не вдався (спроба ${i + 1}/3)`);
		}
	}
	return false;
}

async function triggerDeploys() {
	const hooks = [
		['huphub.link', process.env.SITE_DEPLOY_HOOK],
		['ai-soft.org.ua', process.env.AI_SOFT_DEPLOY_HOOK],
	].filter(([, h]) => h);
	if (!hooks.length) return log('SITE_DEPLOY_HOOK / AI_SOFT_DEPLOY_HOOK не задано — сайт оновиться лише власним розкладом');
	if (DRY) return log(`[DRY] деплой: ${hooks.map(([n]) => n).join(', ')}`);
	await sleep(RAW_CACHE_MS);
	for (const [name, hook] of hooks) {
		try {
			const res = await fetch(hook, { method: 'POST' });
			log(`Деплой ${name}: ${res.status}`);
		} catch (e) {
			log(`Деплой ${name} не вдався: ${e.message}`);
		}
	}
}

(async () => {
	log(`Черговий парсера: цикл ${LOOP_MIN} хв${DRY ? ' (DRY_RUN)' : ''}`);
	let lastCommit = Date.now();
	let runs = 0;
	while (Date.now() < deadline) {
		runs++;
		const ok = scrape();
		let wait = RETRY_MS;
		if (ok) {
			const next = readJson('all-posts.json');
			const changed = next.ok !== false && sig(headJson('all-posts.json')) !== sig(next);
			const share = todayShare(next);
			log(`Запуск ${runs}: змінилось=${changed}, сьогоднішніх даних ${Math.round(share * 100)}%`);
			const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
			if (changed) {
				if (commit(`update hydro data — all rivers ${stamp} UTC`)) {
					lastCommit = Date.now();
					await triggerDeploys();
				}
			} else if (Date.now() - lastCommit >= HEARTBEAT_MS) {
				if (commit(`heartbeat — hydro data unchanged ${stamp} UTC`)) lastCommit = Date.now();
			}
			wait = share >= COMPLETE_SHARE ? SLOW_MS : FAST_MS;
		}
		const left = deadline - Date.now();
		if (left <= 0) break;
		await sleep(Math.min(wait, left));
	}
	const minutes = Math.round((Date.now() - started) / 60e3);
	log(`Цикл завершено: ${runs} запусків за ${minutes} хв`);
	// Наступну зміну запускаємо, лише якщо цикл справді відпрацював (захист від швидкого «кільця» перезапусків при збої)
	if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `chain=${minutes >= Math.min(60, LOOP_MIN) ? 'true' : 'false'}\n`);
})();
