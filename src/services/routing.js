function shouldUseContextTranslation(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  const lines = value.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const hasStructuredLayout = /(^|\n)\s*(?:[-*•●▪]|\d+[.)、])\s+/m.test(value)
    || /\t| {3,}/.test(value)
    || lines.length >= 4;
  const chineseSentenceCount = (value.match(/[。！？]/g) || []).length;
  const latinSentenceCount = (value.match(/[.!?](?=\s|$)/g) || []).length;
  const sentenceCount = chineseSentenceCount + latinSentenceCount;
  return value.length >= 110 || hasStructuredLayout || (value.length >= 60 && sentenceCount >= 2);
}

module.exports = { shouldUseContextTranslation };
