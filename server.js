const express = require('express');
const os = require('os');
const readline = require('readline');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const refreshMs = Number(process.env.REFRESH_MS || 15000);

const sources = [
  {
    id: 'bus',
    name: 'Автобуси',
    url: process.env.BUS_API_URL || 'https://api-t900.icity.com.ua/api/gps_data/',
    vehicleType: 'BUS'
  },
  {
    id: 'electric',
    name: 'Електротранспорт',
    url: process.env.ELECTRIC_API_URL || 'http://46.4.68.233:23450/api/gps-data',
    vehicleType: 'ELECTRIC'
  }
];

let refreshTimer;
let isRefreshing = false;
let autoRefresh = true;

function getLanIps() {
  return Object.values(os.networkInterfaces()).flat().filter((item) => item && item.family === 'IPv4' && !item.internal).map((item) => item.address);
}

function primaryLanIp() {
  return getLanIps()[0] || 'IP не знайдено';
}

function printMenu(message = '') {
  console.clear();
  const ip = primaryLanIp();
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║        DNIPRO TRANSPORT GTFS-RT GATEWAY                   ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║ Статус:            ${(cache.feed ? 'ПРАЦЮЄ' : 'ЗАПУСК').padEnd(38)}║`);
  console.log(`║ IP комп'ютера:     ${ip.padEnd(38)}║`);
  console.log(`║ Порт:              ${String(port).padEnd(38)}║`);
  console.log(`║ Оновлення:         ${(autoRefresh ? 'АВТО' : 'ПРИЗУПИНЕНО').padEnd(38)}║`);
  console.log(`║ Інтервал:          ${(refreshMs / 1000 + ' сек.').padEnd(38)}║`);
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║ ДЖЕРЕЛА ДАНИХ                                             ║');
  sources.forEach((source) => {
    const status = cache.sourceStatus[source.id];
    const line = `${source.name}: ${status?.ok ? 'OK' : status ? 'ПОМИЛКА' : 'ОЧІКУВАННЯ'} | ТЗ: ${status?.vehicles ?? 0}`;
    console.log(`║ ${line.padEnd(58)}║`);
  });
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║ ВСЬОГО ТЗ ПЕРЕДАЄМО: ${String(cache.totalVehicles).padEnd(37)}║`);
  console.log(`║ Останнє оновлення: ${(cache.generatedAt ? new Date(cache.generatedAt).toLocaleTimeString('uk-UA') : 'ще не було').padEnd(39)}║`);
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║ GTFS-RT: http://${ip}:${port}/gtfs-rt/vehicle-positions.pb`);
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║ КОМАНДИ: [R] оновити  [P] пауза/авто  [Q] вихід           ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  if (message) console.log(`\n${message}`);
}


function validCoordinate(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
    !(lat === 0 && lon === 0);
}

function normalizePosition(source, position) {
  const lat = Number(position.lat);
  const lon = Number(position.lon);
  if (!validCoordinate(lat, lon)) return null;

  const id = String(position.gps_id || `${source.id}-${position.bort_number || position.number}`);
  const timestamp = Number(position.timestamp);
  return {
    id,
    label: String(position.bort_number || position.number || id),
    routeId: position.number == null ? undefined : String(position.number),
    lat,
    lon,
    speed: Math.max(0, Number(position.speed) || 0) / 3.6,
    bearing: Number.isFinite(Number(position.azimuth)) ? Number(position.azimuth) : undefined,
    timestamp: Number.isFinite(timestamp) ? timestamp : Math.floor(Date.now() / 1000),
    source: source.id,
    vehicleType: source.vehicleType
  };
}

async function fetchSource(source) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.SOURCE_TIMEOUT_MS || 10000));
  try {
    const response = await fetch(source.url, {
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const positions = Array.isArray(body.positions) ? body.positions : [];
    return positions.map((p) => normalizePosition(source, p)).filter(Boolean);
  } finally {
    clearTimeout(timeout);
  }
}

function buildFeed(vehicles) {
  const feed = {
    header: {
      gtfsRealtimeVersion: '2.0',
      incrementality: 'FULL_DATASET',
      timestamp: Math.floor(Date.now() / 1000)
    },
    entity: vehicles.map((vehicle) => ({
      id: `${vehicle.source}-${vehicle.id}`,
      vehicle: {
        trip: vehicle.routeId ? { routeId: vehicle.routeId } : undefined,
        vehicle: { id: vehicle.id, label: vehicle.label },
        position: {
          latitude: vehicle.lat,
          longitude: vehicle.lon,
          bearing: vehicle.bearing,
          speed: vehicle.speed
        },
        timestamp: vehicle.timestamp
      }
    }))
  };
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.encode(
    GtfsRealtimeBindings.transit_realtime.FeedMessage.create(feed)
  ).finish();
}

async function refresh() {
  if (isRefreshing) return;
  isRefreshing = true;
  const startedAt = Date.now();
  const results = await Promise.allSettled(sources.map(fetchSource));
  const vehicles = [];
  const sourceStatus = {};
  results.forEach((result, index) => {
    const source = sources[index];
    if (result.status === 'fulfilled') {
      vehicles.push(...result.value);
      sourceStatus[source.id] = { ok: true, vehicles: result.value.length };
    } else {
      sourceStatus[source.id] = { ok: false, vehicles: 0, error: result.reason.message };
      console.error(`[${source.id}] ${result.reason.message}`);
    }
  });
  cache = { feed: buildFeed(vehicles), generatedAt: Date.now(), sourceStatus, totalVehicles: vehicles.length, durationMs: Date.now() - startedAt };
  isRefreshing = false;
  printMenu();
}

app.get('/gtfs-rt/vehicle-positions.pb', (req, res) => {
  if (!cache.feed) return res.status(503).json({ error: 'Feed is not ready' });
  res.type('application/x-protobuf').set('Cache-Control', 'no-store').send(cache.feed);
});

app.get('/health', (req, res) => res.json({
  status: cache.feed ? 'ok' : 'starting',
  generatedAt: cache.generatedAt,
  totalVehicles: cache.totalVehicles,
  sources: cache.sourceStatus
}));
app.get('/', (req, res) => res.json({ service: 'Dnipro GTFS-RT gateway', endpoints: ['/gtfs-rt/vehicle-positions.pb', '/health'] }));

function setupConsoleControls() {
  if (!process.stdin.isTTY) return;
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', async (_, key) => {
    const command = key.sequence.toLowerCase();
    if (command === 'q' || (key.ctrl && command === 'c')) {
      console.log('\nЗавершення роботи...');
      process.exit(0);
    }
    if (command === 'r') {
      await refresh();
      printMenu('Виконано ручне оновлення.');
    }
    if (command === 'p') {
      autoRefresh = !autoRefresh;
      if (autoRefresh) {
        refreshTimer = setInterval(refresh, refreshMs);
        printMenu('Автоматичне оновлення увімкнено.');
      } else {
        clearInterval(refreshTimer);
        printMenu('Автоматичне оновлення призупинено.');
      }
    }
  });
}

app.listen(port, host, async () => {
  setupConsoleControls();
  await refresh();
  refreshTimer = setInterval(refresh, refreshMs);
});
