export const VIEWPORT_LABELS = Object.freeze({desktop: 'Desktop', laptop: 'Laptop', tablet: 'Tablet', phone: 'Phone', unknown: 'Unspecified viewport'});

export function viewportKey(width) {
  if (!Number.isFinite(width) || width <= 0) return 'unknown';
  return width >= 1440 ? 'desktop' : width >= 1280 ? 'laptop' : width >= 768 ? 'tablet' : 'phone';
}

export function commentViewportKey(comment) {
  const context = comment?.context?.production || comment?.selection?.context;
  const key = context?.viewportProfile?.key;
  // A saved profile is historical evidence. Never relabel an explicit legacy
  // Desktop or Tablet capture just because the available presets have changed.
  return ['desktop', 'laptop', 'tablet', 'phone'].includes(key) ? key : viewportKey(context?.viewport?.width);
}

export function viewportLabel(comment) {
  const context = comment?.context?.production || comment?.selection?.context;
  const size = context?.viewport;
  const dimensions = Number.isFinite(size?.width) && Number.isFinite(size?.height) ? ` · ${Math.round(size.width)} × ${Math.round(size.height)}` : '';
  return VIEWPORT_LABELS[commentViewportKey(comment)] + dimensions;
}

export function commentMatchesViewport(comment, key) {
  const captured = commentViewportKey(comment);
  return captured === 'unknown' || captured === key;
}
