/**
 * Серверный прокси и кэширующий шлюз для официального сайта расписания ТОГУ (https://togudv.ru/rasp/groups/)
 * Запуск: node server/toguServer.mjs (по умолчанию порт 3001)
 *
 * Реализует:
 * - Защиту от блокировки CORS в браузере
 * - Rate Limiting (ограничение частоты запросов к togudv.ru не чаще 1 раза в 2.5 сек)
 * - In-memory кэширование ответов (TTL 30 минут) и отдачу последней сохранённой версии при сбое togudv.ru
 * - Отсутствие секретных ключей на клиенте (все настройки через переменные окружения процесса)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TOGU_SERVER_PORT || 3001);
const TOGU_BASE_URL = process.env.TOGU_BASE_URL || 'https://togudv.ru';
const CACHE_TTL_MS = Number(process.env.TOGU_CACHE_TTL_MS || 30 * 60 * 1000); // 30 минут
const MIN_INTERVAL_MS = Number(process.env.TOGU_RATE_LIMIT_MS || 2500); // 2.5 секунды между запросами к сайту вуза
const FETCH_TIMEOUT_MS = Number(process.env.TOGU_FETCH_TIMEOUT_MS || 10000);

// Хранилище кэша в памяти сервера: key -> { html, fetchedAt, source }
const htmlCache = new Map();
let lastUpstreamRequestTime = 0;

async function throttledFetchTogu(relativePath) {
  const now = Date.now();
  const cached = htmlCache.get(relativePath);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return { ...cached, fromCache: true };
  }

  // Rate limiting
  const elapsed = now - lastUpstreamRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
  }
  lastUpstreamRequestTime = Date.now();

  const targetUrl = `${TOGU_BASE_URL}${relativePath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'TOGU-Schedule-Student-App/1.0 (+https://togudv.ru/rasp/groups/)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru-RU,ru;q=0.9',
      },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} при обращении к ${targetUrl}`);
    }

    const html = await response.text();
    const record = {
      html,
      fetchedAt: Date.now(),
      fetchedAtIso: new Date().toISOString(),
      source: 'live_togudv',
      url: targetUrl,
    };
    htmlCache.set(relativePath, record);
    return { ...record, fromCache: false };
  } catch (err) {
    clearTimeout(timeout);
    // Если есть устаревший кэш, возвращаем его с флагом staleCache
    if (cached) {
      return { ...cached, fromCache: true, staleCache: true, upstreamError: String(err.message || err) };
    }
    throw err;
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/api/togu/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok', cacheEntries: htmlCache.size, timestamp: new Date().toISOString() }));
      return;
    }

    if (url.pathname === '/api/togu/groups') {
      const semester = url.searchParams.get('semester');
      const rel = semester ? `/rasp/groups/?semester=${encodeURIComponent(semester)}` : '/rasp/groups/';
      const data = await throttledFetchTogu(rel);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
      return;
    }

    const groupMatch = url.pathname.match(/^\/api\/togu\/groups\/(\d+)\/?$/);
    if (groupMatch) {
      const groupId = groupMatch[1];
      const rel = `/rasp/groups/${groupId}/`;
      const data = await throttledFetchTogu(rel);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'NOT_FOUND', message: 'Неизвестный маршрут API' }));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: 'UPSTREAM_UNAVAILABLE',
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      })
    );
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  server.listen(PORT, () => {
    console.log(`[TOGU Proxy Server] Запущен на http://localhost:${PORT}`);
  });
}

export { server };
