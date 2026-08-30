import lingXiSvgMarkup from '../../assets/LingXi.svg';

const DEFAULT_LOGO_SIZE = 16;

export const LINGXI_RIBBON_ICON_ID = 'lingxi-logo';

export function createLingXiLogoSvg(size: number): SVGSVGElement {
  const parsedSvg = new DOMParser()
    .parseFromString(lingXiSvgMarkup, 'image/svg+xml')
    .querySelector('svg');
  if (!parsedSvg) {
    throw new Error('LingXi logo asset does not contain an SVG element');
  }

  const svg = activeDocument.importNode(parsedSvg, true);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.querySelectorAll('[fill="#000000"]').forEach((element) => {
    element.setAttribute('fill', 'currentColor');
  });
  return svg;
}

export function createLingXiLogoSvgMarkup(): string {
  const svg = createLingXiLogoSvg(DEFAULT_LOGO_SIZE);
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  return svg.outerHTML;
}
