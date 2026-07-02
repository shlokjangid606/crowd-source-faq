/**
 * webTextSource — Phase 5.
 *
 * `RetrievalSource` for admin-pasted web pages (`WebPage` collection).
 * Returns hits ranked by Mongo `$text` score, with per-page confidence
 * decaying from 0.85 → 0.5 once the page is older than 7 days.
 *
 * Confidence rationale
 * --------------------
 *  - 0.85 (fresh) sits between community (0.85) and kb (1.1) — web
 *    pages are curated (admin-pasted) but the content is out of our
 *    control, so we don't give them the same trust as a Q&A we wrote.
 *  - After 7d, confidence drops to 0.5 — admin can re-fetch via
 *    `POST /admin/web-pages` with the same URL to refresh.
 *
 * Filtering
 * ---------
 *  - Always excludes rows where `lastFetchError` is set (broken pages
 *    shouldn't be returned to users).
 *  - `batchId` is accepted for API compatibility with the rest of the
 *    retrieval sources, but WebPage documents don't carry a batchId so
 *    the filter is a no-op here.
 */

import WebPage from '../../models/WebPage.js';
import { cronLog } from '../../utils/http/logger.js';
import type { RetrievalSource } from '../contextRetriever.js';

const STALE_DAYS = 7;

export const webTextSource: RetrievalSource = {
  name: 'web',
  weight: 0.9, // curated but untrusted — between community (0.85) and kb (1.1)

  async search(query, batchId, opts) {
    const topK = opts.topK ?? 3;
    try {
      const filter: Record<string, unknown> = { lastFetchError: null };
      if (batchId) filter.batchId = batchId;
      const docs = await WebPage.find(
        { ...filter, $text: { $search: query } },
        { score: { $meta: 'textScore' } },
      )
        .sort({ score: { $meta: 'textScore' } })
        .limit(topK)
        .lean();

      const now = Date.now();
      const staleCutoffMs = STALE_DAYS * 24 * 60 * 60 * 1000;
      return docs.map((d) => {
        const fetchedAt: Date | null = (d as { fetchedAt?: Date }).fetchedAt ?? null;
        const ageMs = fetchedAt ? now - fetchedAt.getTime() : staleCutoffMs;
        const confidence = ageMs < staleCutoffMs ? 0.85 : 0.5; // decay after 7d
        return {
          source: 'web' as const,
          sourceId: String((d as { _id: unknown })._id),
          question: (d as { title?: string }).title ?? (d as { url?: string }).url ?? '',
          answer: (d as { text?: string }).text ?? '',
          score: Number((d as { score?: number }).score ?? 0),
          confidence,
          matchedOn: 'WebPage.title+text',
          batchId: (d as { batchId?: { toString(): string } }).batchId?.toString() ?? null,
          meta: {
            url: (d as { url?: string }).url,
            domain: (d as { domain?: string }).domain,
            fetchedAt,
            ageDays: ageMs / (24 * 60 * 60 * 1000),
          },
        };
      });
    } catch (err) {
      cronLog.warn(`[webTextSource] search failed: ${(err as Error).message}`);
      return [];
    }
  },
};
