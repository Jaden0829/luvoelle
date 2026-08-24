const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const FRIEND_DEEPSEEK_MARKER = 'friend-deepseek-v4-flash';

function isFriendDistribution(packageMetadata = {}) {
  return packageMetadata.luvoelleDistribution === 'friend';
}

function applyDistributionDefaults(settings, packageMetadata = {}) {
  if (!isFriendDistribution(packageMetadata)) return { ...settings };
  return {
    ...settings,
    provider: 'deepseek',
    endpoint: DEEPSEEK_ENDPOINT,
    model: DEEPSEEK_MODEL,
    distributionDefaultApplied: FRIEND_DEEPSEEK_MARKER,
  };
}

function migrateDistributionSettings(settings, packageMetadata = {}) {
  if (!isFriendDistribution(packageMetadata)) return { settings: { ...settings }, changed: false };
  if (settings.distributionDefaultApplied) return { settings: { ...settings }, changed: false };

  const shouldAdoptDeepSeek = (!settings.provider || settings.provider === 'google')
    && !settings.apiKeyEncrypted;
  return {
    settings: {
      ...settings,
      ...(shouldAdoptDeepSeek ? {
        provider: 'deepseek',
        endpoint: DEEPSEEK_ENDPOINT,
        model: DEEPSEEK_MODEL,
      } : {}),
      distributionDefaultApplied: shouldAdoptDeepSeek ? FRIEND_DEEPSEEK_MARKER : 'friend-existing-choice-preserved',
    },
    changed: true,
  };
}

module.exports = {
  DEEPSEEK_ENDPOINT,
  DEEPSEEK_MODEL,
  FRIEND_DEEPSEEK_MARKER,
  applyDistributionDefaults,
  isFriendDistribution,
  migrateDistributionSettings,
};
