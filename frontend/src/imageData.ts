// Images drawn through a canvas so other code can embed them: Mermaid SVGs
// and raster images for the PDF export (chatPdf.ts), and a PNG chart file
// for relics (relicFiles.ts).

export interface PdfImage {
  /** data: URL, PNG or JPEG. */
  dataUrl: string
  format: 'PNG' | 'JPEG'
  /** Natural size in CSS px. */
  width: number
  height: number
}

function loadImage(src: string, crossOrigin: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    if (crossOrigin) img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load the image'))
    img.src = src
  })
}

function drawToCanvas(img: CanvasImageSource, width: number, height: number, scale: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(width * scale)
  canvas.height = Math.ceil(height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not draw the image')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas
}

// An SVG string (with explicit width/height, as renderMermaidSvg returns)
// drawn onto a white canvas at `scale`.
async function svgCanvas(svg: string, scale: number): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  const width = parseFloat(root.getAttribute('width') ?? '') || 1200
  const height = parseFloat(root.getAttribute('height') ?? '') || 800
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, false)
  return { canvas: drawToCanvas(img, width, height, scale), width, height }
}

export async function svgToPng(svg: string, scale = 2): Promise<Blob> {
  const { canvas } = await svgCanvas(svg, scale)
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not draw the chart as an image'))), 'image/png'))
}

export async function svgToPdfImage(svg: string, scale = 2): Promise<PdfImage> {
  const { canvas, width, height } = await svgCanvas(svg, scale)
  return { dataUrl: canvas.toDataURL('image/png'), format: 'PNG', width, height }
}

// A photo or generated image by URL. Other sites' images need CORS to be
// read back from the canvas; null when that (or loading) fails.
export async function rasterToPdfImage(src: string): Promise<PdfImage | null> {
  try {
    const sameOrigin = src.startsWith('data:') || src.startsWith('blob:') || new URL(src, location.href).origin === location.origin
    const img = await loadImage(src, !sameOrigin)
    const width = img.naturalWidth || 800
    const height = img.naturalHeight || 600
    // Capped so a large photo doesn't bloat the PDF.
    const scale = Math.min(1, 1600 / width)
    const canvas = drawToCanvas(img, width, height, scale)
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.88), format: 'JPEG', width, height }
  } catch {
    return null
  }
}
