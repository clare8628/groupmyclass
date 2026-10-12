/* 學生分組系統 — Worker 進入點
   /api/state、/api/action、/api/bulletin；其餘交給靜態資源（public/）。 */
import { json, bad, runScheduledCleanup, runAttendanceReminders, readSession, getReminderSettingsRow, verifyLineSignature, replyLineMessage } from './lib.js';
import { handleState, handleAction } from './api.js';
import { fetchNotionBulletin } from './bulletin.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/bulletin' && request.method === 'GET') {
        try {
          const items = await fetchNotionBulletin();
          return json({ ok: true, items }, 200, { 'cache-control': 'public, max-age=300' });
        } catch (err) {
          return bad(String((err && err.message) || err), 500);
        }
      }

      const db = env.DB;
      if (!db) return bad('D1 binding "DB" 未設定', 500);
      try {
        if (url.pathname === '/api/state' && request.method === 'GET') return await handleState(request, env, db);
        if (url.pathname === '/api/action' && request.method === 'POST') return await handleAction(request, env, db, await request.json());

        /* 老師後台：下載課表截圖（base64 圖片不隨 /api/state 輪詢傳送，僅於此按需下載） */
        if (url.pathname === '/api/attendance-reminder-screenshot' && request.method === 'GET') {
          const session = await readSession(db, env, request);
          if (!session || session.role !== 'teacher') return bad('需要老師權限', 403);
          const courseId = url.searchParams.get('courseId') || '';
          const row = courseId ? await getReminderSettingsRow(db, courseId) : null;
          if (!row || !row.screenshot) return bad('尚未上傳課表截圖', 404);
          const bytes = Uint8Array.from(atob(row.screenshot), ch => ch.charCodeAt(0));
          return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png', 'cache-control': 'private, no-cache' } });
        }

        /* LINE Webhook：老師將 Bot 加入班級群組時，於群組內回覆群組 ID 供老師複製貼上設定 */
        if (url.pathname === '/api/line-webhook' && request.method === 'POST') {
          const rawBody = await request.text();
          if (!await verifyLineSignature(env, rawBody, request.headers.get('x-line-signature'))) return bad('簽章驗證失敗', 403);
          const payload = JSON.parse(rawBody || '{}');
          for (const evt of (payload.events || [])) {
            const src = evt.source || {};
            const inGroup = src.type === 'group' || src.type === 'room';
            const askId = evt.type === 'message' && evt.message && evt.message.type === 'text' && /^\s*(群組\s*id|group\s*id)\s*$/i.test(evt.message.text || '');
            if (inGroup && (evt.type === 'join' || askId)) {
              const groupId = src.groupId || src.roomId;
              await replyLineMessage(env, evt.replyToken, `本群組 ID：\n${groupId}\n請複製貼到老師後台「點名管理 → 點名自動提醒」的群組 ID 欄位。`);
            }
          }
          return json({ ok: true });
        }

        return bad('Not found', 404);
      } catch (err) {
        return bad(String((err && err.message) || err), 500);
      }
    }

    return env.ASSETS.fetch(request);
  },

  // Cron Trigger：
  // - "0 19 * * *"（台北 03:00）：每日清除超過六個月的點名／問卷異動紀錄
  // - 每 5 分鐘一次：比對每門課的每週課表，命中「第一節上課時間＋提醒延遲」即發送點名提醒 LINE 訊息
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    if (event.cron === '*/5 * * * *') {
      ctx.waitUntil(runAttendanceReminders(env.DB, env).then(r => { if (r.length) console.log('attendance-reminder', JSON.stringify(r)); }));
      return;
    }
    ctx.waitUntil(runScheduledCleanup(env.DB).then(r => console.log('log-cleanup', JSON.stringify(r))));
  },
};
