function mapViewportRectToPixels(rect, viewport, pixels) {
  const values = [rect?.left, rect?.top, rect?.width, rect?.height].map(Number);
  const viewportWidth = Number(viewport?.width);
  const viewportHeight = Number(viewport?.height);
  const pixelWidth = Math.round(Number(pixels?.width));
  const pixelHeight = Math.round(Number(pixels?.height));
  if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0
    || !Number.isFinite(viewportWidth) || viewportWidth <= 0
    || !Number.isFinite(viewportHeight) || viewportHeight <= 0
    || !Number.isFinite(pixelWidth) || pixelWidth <= 0
    || !Number.isFinite(pixelHeight) || pixelHeight <= 0) return null;
  const scaleX = pixelWidth / viewportWidth;
  const scaleY = pixelHeight / viewportHeight;
  const left = Math.max(0, Math.min(pixelWidth - 1, Math.round(values[0] * scaleX)));
  const top = Math.max(0, Math.min(pixelHeight - 1, Math.round(values[1] * scaleY)));
  const right = Math.max(left + 1, Math.min(pixelWidth, Math.round((values[0] + values[2]) * scaleX)));
  const bottom = Math.max(top + 1, Math.min(pixelHeight, Math.round((values[1] + values[3]) * scaleY)));
  return { left, top, right, bottom, width: right - left, height: bottom - top, scaleX, scaleY };
}

module.exports = { mapViewportRectToPixels };
