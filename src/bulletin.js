import { INITIAL_BULLETIN_PAGES } from './bulletin-snapshot.js';

const NOTION_ROOT_PAGE_ID = '975bbaa1-9830-833e-9557-01873b3181e5';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分鐘快取，避免重複請求 Notion

let bulletinCache = {
  items: INITIAL_BULLETIN_PAGES,
  lastFetched: 0,
};

export async function fetchNotionBulletin() {
  const now = Date.now();
  if (bulletinCache.lastFetched && (now - bulletinCache.lastFetched < CACHE_TTL_MS)) {
    return bulletinCache.items;
  }

  try {
    let cursor = { stack: [] };
    let allBlocks = {};
    let chunkNumber = 0;
    while (true) {
      const res = await fetch('https://www.notion.so/api/v3/loadPageChunk', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        body: JSON.stringify({
          pageId: NOTION_ROOT_PAGE_ID,
          limit: 100,
          chunkNumber,
          cursor,
          verticalColumns: false,
        }),
      });

      if (!res.ok) throw new Error(`Notion loadPageChunk status ${res.status}`);
      const data = await res.json();
      if (!data || !data.recordMap || !data.recordMap.block) break;
      Object.assign(allBlocks, data.recordMap.block);
      if (!data.cursor || !data.cursor.stack || !data.cursor.stack.length || chunkNumber >= 10) break;
      cursor = data.cursor;
      chunkNumber++;
    }

    const rootBlock = allBlocks[NOTION_ROOT_PAGE_ID]?.value?.value || allBlocks[NOTION_ROOT_PAGE_ID]?.value;
    if (!rootBlock || !rootBlock.content) return bulletinCache.items;

    let underBulletin = false;
    const bulletinPages = [];

    for (const blockId of rootBlock.content) {
      const b = allBlocks[blockId]?.value?.value || allBlocks[blockId]?.value;
      if (!b) continue;
      const title = b.properties?.title ? b.properties.title.map(p => p[0]).join('') : '';

      if (b.type === 'text' && title.includes('公佈欄')) {
        underBulletin = true;
        continue;
      }
      if (underBulletin && (title.includes('本班目標') || title.includes('班級幹部'))) {
        underBulletin = false;
        break;
      }
      if (underBulletin && b.type === 'page') {
        const trimmed = title.trim();
        const dateMatch = trimmed.match(/(\d{8})/);
        const date = dateMatch ? dateMatch[1] : '';
        bulletinPages.push({
          id: blockId,
          date,
          title: trimmed,
          url: `https://app.notion.com/p/${blockId.replace(/-/g, '')}`,
        });
      }
    }

    if (bulletinPages.length > 0) {
      bulletinCache.items = bulletinPages;
      bulletinCache.lastFetched = now;
    }
  } catch (err) {
    console.warn('[Notion Bulletin] 更新失敗，使用快取或備援資料:', err.message);
  }

  return bulletinCache.items;
}
