// Offline Mode (PWA) — headless manager component.
//
// Mounted once near the root of the app (inside FeatureFlagProvider, so
// the flag's real value is available). Renders nothing; its only job is
// to enable/disable the service worker whenever the `offlineMode` flag
// value changes — including live, if an admin flips it off while the
// user is on the page.

import { useEffect } from 'react';
import { useFeatureFlag } from '../context/FeatureFlagContext';
import { enableOfflineMode, disableOfflineMode } from './registerOfflineServiceWorker';

export default function OfflineModeManager(): null {
  const { enabled, loading } = useFeatureFlag('offlineMode');

  useEffect(() => {
    // Don't act on the flag's default (`false`) fallback while the real
    // value is still loading — that would briefly unregister an already-
    // active service worker from a previous session on every page load.
    if (loading) return;

    if (enabled) {
      enableOfflineMode();
    } else {
      disableOfflineMode();
    }
  }, [enabled, loading]);

  return null;
}
