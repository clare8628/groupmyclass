/* 學生分組系統 — Worker 進入點
   /api/state、/api/action 走 D1；其餘交給靜態資源（public/）。 */
import { bad, cleanupOldLogs } from './lib.js';
import { handleState, handleAction } from './api.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      const db = env.DB;
      if (!db) return bad('D1 binding "DB" 未設定', 500);
      try {
        if (url.pathname === '/api/state' && request.method === 'GET') return await handleState(request, env, db);
        if (url.pathname === '/api/action' && request.method === 'POST') return await handleAction(request, env, db, await request.json());
        return bad('Not found', 404);
      } catch (err) {
        return bad(String((err && err.message) || err), 500);
      }
    }

    return env.ASSETS.fetch(request);
  },

  /* Cron Trigger：每日清除超過六個月的點名／問卷異動紀錄 */
  async scheduled(event, env, ctx) {
    if (env.DB) ctx.waitUntil(cleanupOldLogs(env.DB).then(n => console.log(`cleanupOldLogs: deleted ${n} rows`)));
  },
};
