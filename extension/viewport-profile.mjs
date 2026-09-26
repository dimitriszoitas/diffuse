export const VIEWPORT_LABELS = Object.freeze({desktop: 'Desktop', tablet: 'Laptop / tablet', phone: 'Phone', unknown: 'Unspecified viewport'});

export function viewportKey(width) {
  if (!Number.isFinite(width) || width <= 0) return 'unknown';
  return width >= 1280 ? 'desktop' : width >= 768 ? 'tablet' : 'phone';
}

export function commentViewportKey(comment) {
  const context = comment?.context?.production || comment?.selection?.context;
  const key = context?.viewportProfile?.key;
  return ['desktop', 'tablet', 'phone'].includes(key) ? key : viewportKey(context?.viewport?.width);
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
