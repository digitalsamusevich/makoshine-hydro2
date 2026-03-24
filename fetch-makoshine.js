const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const PAGE_URL    = 'https://www.meteo.gov.ua/ua/Shchodenna-hidrolohichna-situaciya';
const CACHE_FILE   = path.join(__dirname, 'marker-cache.json');
const OUTPUT_FILE  = path.join(__dirname, 'all-posts.json');
const HISTORY_FILE = path.join(__dirname, 'all-history.json');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── I/O ──────────────────────────────────────────────────────────────────────

function loadJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath))
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {}
  return fallback;
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

const loadCache   = () => loadJson(CACHE_FILE,   {});
const saveCache   = c  => saveJson(CACHE_FILE, c);
const loadHistory = () => loadJson(HISTORY_FILE, {});
const saveHistory = h  => saveJson(HISTORY_FILE, h);

// ── History (повна, без обмежень) ────────────────────────────────────────────

function updateHistory(postMap) {
  const history = loadHistory();
  const today   = new Date().toISOString().slice(0, 10);

  for (const key in postMap) {
    const post = postMap[key];
    if (!history[key]) history[key] = [];

    const last = history[key][history[key].length - 1];

    if (last && last.date === today) {
      // Оновлюємо сьогоднішній запис замість дублювання
      last.level       = post.water_level_cm;
      last.temperature = post.water_temperature_c;
      last.delta       = post.delta_24h_cm;
    } else {
      history[key].push({
        date:        today,
        level:       post.water_level_cm,
        temperature: post.water_temperature_c,
        delta:       post.delta_24h_cm,
      });
    }
    // Без обмеження — зберігається вся історія з першого дня
  }

  saveHistory(history);
  return history;
}

// ── Chart (QuickChart.io) ────────────────────────────────────────────────────

function formatShortDate(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${d}.${m}`;
}

function buildQuickChartUrl(title, historyItems) {
  if (!historyItems || historyItems.length === 0) return null;

  // Для графіку беремо останні 30 точок щоб URL не був надто довгим
  const slice  = historyItems.slice(-30);
  const labels = slice.map(i => formatShortDate(i.date));
  const data   = slice.map(i => i.level);

  const isFalling = data.length > 1 && data[data.length - 1] < data[0];
  const lineColor = isFalling ? 'rgb(22,163,74)' : 'rgb(37,99,235)';
  const fillColor = isFalling ? 'rgba(22,163,74,0.18)' : 'rgba(37,99,235,0.18)';

  const cfg = {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label:                title,
        data,
        borderColor:          lineColor,
        backgroundColor:      fillColor,
        fill:                 true,
        tension:              0.35,
        borderWidth:          3,
        pointRadius:          4,
        pointHoverRadius:     5,
        pointBackgroundColor: lineColor,
        pointBorderColor:     '#ffffff',
        pointBorderWidth:     2,
      }],
    },
    options: {
      layout: { padding: { top: 10, right: 18, bottom: 10, left: 10 } },
      plugins: {
        title: {
          display: true,
          text:    `${title} — рівень води`,
          font:    { size: 18, family: 'sans-serif' },
          color:   '#1f2937',
          padding: { bottom: 12 },
        },
        legend: { display: false },
      },
      scales: {
        x: {
          ticks: { color: '#6b7280', font: { size: 11 } },
          grid:  { color: 'rgba(0,0,0,0.04)' },
        },
        y: {
          ticks: {
            color:    '#6b7280',
            font:     { size: 11 },
            callback: 'function(v){ return v+" см"; }',
          },
          title: {
            display: true,
            text:    'Рівень, см',
            color:   '#374151',
            font:    { size: 12 },
          },
          grid: { color: 'rgba(0,0,0,0.06)' },
        },
      },
    },
    plugins: [{
      id: 'lastValueLabel',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        const meta = chart.getDatasetMeta(0);
        if (!meta?.data?.length) return;
        const lastPt = meta.data[meta.data.length - 1];
        const val    = data[data.length - 1];
        if (val === undefined) return;
        ctx.save();
        ctx.font      = 'bold 12px sans-serif';
        ctx.fillStyle = lineColor;
        ctx.textAlign = 'left';
        ctx.fillText(`${val} см`, lastPt.x + 8, lastPt.y - 8);
        ctx.restore();
      },
    }],
  };

  return 'https://quickchart.io/chart?width=900&height=420&c=' +
    encodeURIComponent(JSON.stringify(cfg));
}

// ── Popup parsing ────────────────────────────────────────────────────────────

function parsePopupText(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const result  = {
    post:                null,
    river:               null,
    observed_at:         null,
    water_level_cm:      null,
    delta_direction:     null,
    delta_24h_cm:        null,
    water_temperature_c: null,
    raw_text:            cleaned,
  };

  let m;

  m = cleaned.match(/Пост:\s*([^\n\r]+?)(?=\s*Річка:|\s*Дані на|\s*Фактичний рівень|$)/iu);
  if (m) result.post = m[1].trim();

  m = cleaned.match(/Річка:\s*([^\n\r]+?)(?=\s*Дані на|\s*Фактичний рівень|$)/iu);
  if (m) result.river = m[1].trim();

  m = cleaned.match(/Дані на\s*([0-9]{2}\.[0-9]{2}\.[0-9]{4},\s*[0-9]{2}:[0-9]{2})/iu);
  if (m) result.observed_at = m[1].trim();

  m = cleaned.match(/Фактичний рівень води:\s*(-?[0-9]+)\s*см/iu);
  if (m) result.water_level_cm = parseInt(m[1], 10);

  m = cleaned.match(/Рівень за останню добу:\s*(збільшився|зменшився)\s*на\s*([0-9]+)\s*см/iu);
  if (m) {
    result.delta_direction = m[1];
    const delta = parseInt(m[2], 10);
    result.delta_24h_cm = m[1] === 'зменшився' ? -delta : delta;
  } else if (/Рівень за останню добу:\s*без змін/iu.test(cleaned)) {
    result.delta_direction = 'без змін';
    result.delta_24h_cm    = 0;
  }

  m = cleaned.match(/Температура води:\s*(-?[0-9]+(?:[.,][0-9]+)?)°C/iu);
  if (m) result.water_temperature_c = parseFloat(m[1].replace(',', '.'));

  return result;
}

// ── Browser helpers ──────────────────────────────────────────────────────────

async function getPopupText(page) {
  const popup = page.locator('.leaflet-popup-content');
  if (await popup.count()) return await popup.first().innerText();
  return '';
}

async function clickMarkerAndRead(page, index, totalCount) {
  if (index < 0 || index >= totalCount) {
    return { ok: false, error: `Індекс ${index} поза межами (всього: ${totalCount})` };
  }

  try {
    const markers = page.locator('.leaflet-marker-icon');
    await markers.nth(index).click({ force: true, timeout: 5000 });
    await sleep(420);

    const popupText = await getPopupText(page);
    if (!popupText) return { ok: false, error: `Немає popup для маркера ${index}` };

    return { ok: true, index, popupText, parsed: parsePopupText(popupText) };
  } catch (e) {
    return { ok: false, error: `Помилка кліку ${index}: ${e.message}` };
  }
}

async function getUniqueMarkerIndices(page) {
  const markers = page.locator('.leaflet-marker-icon');
  const count   = await markers.count();
  const seen    = new Set();
  const result  = [];

  for (let i = 0; i < count; i++) {
    try {
      const style = await markers.nth(i).evaluate(el => el.style.transform || '');
      if (!seen.has(style)) { seen.add(style); result.push(i); }
    } catch (e) {}
  }

  return result;
}

// ── Scrape ALL markers ───────────────────────────────────────────────────────

async function scrapeAllMarkers(page, uniqueIndices, cache) {
  const totalCount  = await page.locator('.leaflet-marker-icon').count();
  const postMap     = {};
  const seenKeys    = new Set();
  let   scrapedCount = 0;

  for (const i of uniqueIndices) {
    const r = await clickMarkerAndRead(page, i, totalCount);

    if (!r.ok || !r.parsed.post) continue;

    const key = `${r.parsed.river || ''}__${r.parsed.post}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    // Кешуємо позицію маркера за назвою посту
    cache[r.parsed.post] = i;

    postMap[key] = {
      found_index:         i,
      post:                r.parsed.post,
      river:               r.parsed.river,
      observed_at:         r.parsed.observed_at,
      water_level_cm:      r.parsed.water_level_cm,
      delta_direction:     r.parsed.delta_direction,
      delta_24h_cm:        r.parsed.delta_24h_cm,
      water_temperature_c: r.parsed.water_temperature_c,
    };

    scrapedCount++;
    if (scrapedCount % 10 === 0) {
      console.log(`  ... зібрано ${scrapedCount} постів`);
    }
  }

  return postMap;
}

// ── Group by river ───────────────────────────────────────────────────────────

function groupByRiver(postMap, history) {
  const rivers = {};

  for (const key in postMap) {
    const p         = postMap[key];
    const riverName = p.river || 'Невідома';

    if (!rivers[riverName]) rivers[riverName] = [];

    const histItems = history[key] || [];

    rivers[riverName].push({
      ...p,
      history_points: histItems,
      chart_url:      buildQuickChartUrl(p.post, histItems),
    });
  }

  // Сортуємо пости всередині кожної річки
  for (const r in rivers) {
    rivers[r].sort((a, b) => (a.post || '').localeCompare(b.post || '', 'uk'));
  }

  // Сортуємо річки за алфавітом
  return Object.fromEntries(
    Object.entries(rivers).sort(([a], [b]) => a.localeCompare(b, 'uk'))
  );
}

// ── Entry point ───────────────────────────────────────────────────────────────

(async () => {
  const browser = await chromium.launch({ headless: true, slowMo: 0 });
  const page    = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  try {
    console.log('Завантажуємо сторінку...');
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('.leaflet-container',   { timeout: 30000 });
    await page.waitForSelector('.leaflet-marker-icon', { timeout: 30000 });
    await sleep(2000);

    const cache         = loadCache();
    const uniqueIndices = await getUniqueMarkerIndices(page);
    console.log(`Унікальних маркерів: ${uniqueIndices.length}`);

    // Збираємо всі пости
    const postMap = await scrapeAllMarkers(page, uniqueIndices, cache);
    saveCache(cache);

    const postCount  = Object.keys(postMap).length;
    console.log(`Зібрано постів: ${postCount}`);

    // Оновлюємо повну історію (без обмежень)
    const history = updateHistory(postMap);

    // Групуємо по річках
    const grouped    = groupByRiver(postMap, history);
    const riverCount = Object.keys(grouped).length;

    const result = {
      ok:           true,
      total_rivers: riverCount,
      total_posts:  postCount,
      fetched_at:   new Date().toISOString(),
      rivers:       grouped,
    };

    saveJson(OUTPUT_FILE, result);
    console.log(`Збережено: ${riverCount} річок, ${postCount} постів → all-posts.json`);

  } catch (err) {
    console.error('ПОМИЛКА:', err.message);

    saveJson(OUTPUT_FILE, {
      ok:         false,
      error:      err.message,
      fetched_at: new Date().toISOString(),
    });

    process.exit(1);
  } finally {
    await browser.close();
  }
})();
