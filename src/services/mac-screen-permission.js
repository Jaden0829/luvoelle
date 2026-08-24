const SCREEN_RECORDING_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

function getScreenCaptureStatus(systemPreferences, platform = process.platform) {
  if (platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen') || 'unknown';
  } catch {
    return 'unknown';
  }
}

function hasUsableScreenSources(sources) {
  return Array.isArray(sources) && sources.some((source) => {
    try {
      const size = source?.thumbnail?.getSize?.();
      return Number(size?.width) > 0 && Number(size?.height) > 0 && !source.thumbnail.isEmpty();
    } catch {
      return false;
    }
  });
}

async function ensureScreenCaptureAccess({
  desktopCapturer,
  systemPreferences,
  platform = process.platform,
} = {}) {
  if (platform !== 'darwin') return { granted: true, status: 'granted', requested: false };

  const initialStatus = getScreenCaptureStatus(systemPreferences, platform);
  if (initialStatus === 'granted') return { granted: true, status: initialStatus, requested: false };
  if (initialStatus === 'denied' || initialStatus === 'restricted') {
    return { granted: false, status: initialStatus, requested: false };
  }

  let sources = [];
  let requestError;
  try {
    // macOS presents its own Screen Recording consent sheet on the first real
    // capture attempt. Keeping this probe tiny avoids doing full-resolution
    // work before the user has granted access.
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    });
  } catch (error) {
    requestError = error;
  }

  const status = getScreenCaptureStatus(systemPreferences, platform);
  const granted = status === 'granted' || (status === 'unknown' && hasUsableScreenSources(sources));
  return {
    granted,
    status,
    requested: true,
    error: requestError?.message || '',
  };
}

module.exports = {
  SCREEN_RECORDING_SETTINGS_URL,
  ensureScreenCaptureAccess,
  getScreenCaptureStatus,
  hasUsableScreenSources,
};
