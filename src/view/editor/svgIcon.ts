const SVG_NS = 'http://www.w3.org/2000/svg'

/** The tag and the attributes of each shape of an icon, in drawing order. */
export type IconShapes = ReadonlyArray<readonly [tag: string, attributes: Readonly<Record<string, string>>]>

/** An inline SVG icon in `currentColor`, from the tag and attributes of
 *  each of its shapes. */
export function svgIcon(viewBox: string, shapes: IconShapes): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', viewBox)
  svg.setAttribute('aria-hidden', 'true')
  for (const [tag, attributes] of shapes) {
    const shape = document.createElementNS(SVG_NS, tag)
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value)
    svg.appendChild(shape)
  }
  return svg
}

/** The attributes of a stroked shape with round ends and joins. */
export const ROUND_STROKE = { fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
