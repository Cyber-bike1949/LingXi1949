export interface TooltipRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface TooltipPosition {
  left: number;
  top: number;
  side: 'left' | 'right';
}

export function calculateDirectoryTooltipPosition(
  anchor: TooltipRect,
  tooltip: Pick<TooltipRect, 'width' | 'height'>,
  viewport: { width: number; height: number },
  gap = 8,
  edge = 8,
): TooltipPosition {
  const rightSpace = viewport.width - anchor.right - gap - edge;
  const leftSpace = anchor.left - gap - edge;
  const side = rightSpace >= tooltip.width || rightSpace >= leftSpace ? 'right' : 'left';
  const preferredLeft = side === 'right' ? anchor.right + gap : anchor.left - tooltip.width - gap;
  const maxLeft = Math.max(edge, viewport.width - tooltip.width - edge);
  const maxTop = Math.max(edge, viewport.height - tooltip.height - edge);
  return {
    side,
    left: Math.min(Math.max(edge, preferredLeft), maxLeft),
    top: Math.min(Math.max(edge, anchor.top + (anchor.height - tooltip.height) / 2), maxTop),
  };
}
