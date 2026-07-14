/**
 * useTeeEligibility — Sign My Tee
 *
 * Thin wrapper around the BE `/api/tee/me/eligibility` endpoint that
 * the navbar pill, the gate provider, and the wizard CTA all rely
 * on. Cached for the duration of a page session — eligibility
 * doesn't change second-to-second (the window is days), so we
 * re-fetch only on mount + on user invalidation.
 *
 * Returns `{ eligible, requiresInternshipEndDate, endDate,
 * hasConfiguredTee, shareId, refresh }`. The `refresh` callback
 * lets the gate provider re-fetch after the user successfully
 * saves an end date without remounting the component tree.
 */
import { useEffect, useState, useCallback } from 'react';
import api from '../utils/api';

export interface TeeEligibility {
  eligible: boolean;
  requiresInternshipEndDate: boolean;
  endDate: string | null;
  hasConfiguredTee: boolean;
  shareId: string | null;
}

interface ApiResp {
  eligible: boolean;
  requiresInternshipEndDate: boolean;
  endDate: string | null;
  hasConfiguredTee: boolean;
  shareId: string | null;
}

const EMPTY: TeeEligibility = {
  eligible: false,
  requiresInternshipEndDate: false,
  endDate: null,
  hasConfiguredTee: false,
  shareId: null,
};

export function useTeeEligibility(): TeeEligibility & { refresh: () => Promise<void>; loading: boolean } {
  const [state, setState] = useState<TeeEligibility>(EMPTY);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<ApiResp>('/tee/me/eligibility');
      setState({
        eligible: !!r.data.eligible,
        requiresInternshipEndDate: !!r.data.requiresInternshipEndDate,
        endDate: r.data.endDate ?? null,
        hasConfiguredTee: !!r.data.hasConfiguredTee,
        shareId: r.data.shareId ?? null,
      });
    } catch {
      // Stay at the EMPTY default — the navbar pill stays hidden,
      // the modal stays closed. Network blips don't surface to users.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ...state, refresh, loading };
}
