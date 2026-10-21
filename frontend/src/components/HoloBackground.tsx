import { useEffect, useRef } from 'react'

// Cyberpunk hologram backdrop for the login screen. Pure canvas 2D (no deps,
// no WebGL): a perspective grid floor, rotating HUD rings behind the card,
// falling glyph columns, a slow holographic scan sweep, drifting data motes
// and an occasional subtle glitch band. Everything is dimmed by a vignette in
// the page itself so the sign-in form stays the focus.
//
// Performance/accessibility:
// - capped device pixel ratio (2), single rAF loop, canvas repaints only;
// - the loop pauses while the tab is hidden;
// - prefers-reduced-motion renders one static frame instead of animating.

const CYAN = '34, 211, 238'
const TEAL = '45, 212, 191'
const MAGENTA = '232, 121, 249'
const GLYPHS = '0123456789ABCDEF<>/\\|=+*'

interface Mote {
  x: number
  y: number
  speed: number
  size: number
  phase: number
  hue: 'cyan' | 'magenta'
}

interface RainColumn {
  x: number
  speed: number
  offset: number
  glyphs: string[]
  bright: boolean
}

// Deterministic pseudo-random so layout is stable between resizes.
function seeded(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

export function HoloBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    // jsdom (tests) and very old browsers have no 2D context: the page simply
    // keeps its flat dark background.
    if (!ctx) return

    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let width = 0
    let height = 0
    let motes: Mote[] = []
    let rain: RainColumn[] = []
    let raf = 0
    let start = 0
    let last = 0
    let running = true
    let visible = true

    const buildScene = () => {
      motes = []
      for (let i = 0; i < 64; i++) {
        motes.push({
          x: seeded(i + 1) * width,
          y: seeded(i + 101) * height,
          speed: 6 + seeded(i + 201) * 18,
          size: 0.8 + seeded(i + 301) * 1.7,
          phase: seeded(i + 401) * Math.PI * 2,
          hue: seeded(i + 501) > 0.78 ? 'magenta' : 'cyan',
        })
      }
      const columns = Math.max(8, Math.min(20, Math.round(width / 90)))
      rain = []
      for (let c = 0; c < columns; c++) {
        const glyphs: string[] = []
        for (let g = 0; g < 34; g++) {
          glyphs.push(GLYPHS[Math.floor(seeded(c * 97 + g * 13 + 7) * GLYPHS.length)])
        }
        rain.push({
          x: (c + 0.5) * (width / columns) + (seeded(c + 61) - 0.5) * 26,
          speed: 18 + seeded(c + 71) * 46,
          offset: seeded(c + 81) * height,
          glyphs,
          bright: seeded(c + 91) > 0.72,
        })
      }
    }

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = canvas.clientWidth || window.innerWidth
      height = canvas.clientHeight || window.innerHeight
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      buildScene()
      if (reduced) draw(0)
    }

    const drawGlowLine = (x1: number, y1: number, x2: number, y2: number, color: string, alpha: number, blur: number) => {
      ctx.save()
      ctx.strokeStyle = 'rgba(' + color + ',' + alpha + ')'
      ctx.shadowColor = 'rgba(' + color + ',' + Math.min(1, alpha + 0.25) + ')'
      ctx.shadowBlur = blur
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
      ctx.restore()
    }

    const draw = (t: number) => {
      const horizon = height * 0.6
      ctx.clearRect(0, 0, width, height)

      // Deep-space backdrop with a cyan haze blooming over the horizon.
      const bg = ctx.createLinearGradient(0, 0, 0, height)
      bg.addColorStop(0, '#04060c')
      bg.addColorStop(0.55, '#060b14')
      bg.addColorStop(1, '#04070c')
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, width, height)

      const haze = ctx.createRadialGradient(width / 2, horizon, 0, width / 2, horizon, Math.max(width, height) * 0.62)
      haze.addColorStop(0, 'rgba(' + CYAN + ',0.16)')
      haze.addColorStop(0.45, 'rgba(' + TEAL + ',0.05)')
      haze.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = haze
      ctx.fillRect(0, 0, width, height)

      // Falling glyph rain (cyberpunk data columns), dim enough to sit behind
      // the card. Bright columns occasionally flash.
      ctx.save()
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.textBaseline = 'top'
      const step = 18
      for (const column of rain) {
        const drift = (column.offset + t * column.speed) % (height + 260)
        for (let g = 0; g < column.glyphs.length; g++) {
          const y = drift - g * step
          if (y < -step || y > height) continue
          const fade = 1 - g / column.glyphs.length
          const flicker = 0.55 + 0.45 * Math.sin(t * 2.2 + g * 0.7 + column.x)
          const alpha = (g === 0 ? 0.3 : 0.11) * fade * flicker
          ctx.fillStyle =
            column.bright && g === 0
              ? 'rgba(' + MAGENTA + ',' + alpha + ')'
              : 'rgba(' + CYAN + ',' + alpha + ')'
          ctx.fillText(column.glyphs[g], column.x, y)
        }
        // Bright head pixel for a couple of columns.
        if (column.bright) {
          ctx.fillStyle = 'rgba(' + CYAN + ',0.42)'
          ctx.fillRect(column.x, drift % (height + 260), 6, 2)
        }
      }
      ctx.restore()

      // Perspective grid floor scrolling toward the viewer.
      ctx.save()
      ctx.lineWidth = 1
      const vanishX = width / 2
      const scroll = (t * 0.055) % 1
      const rows = 20
      for (let k = 0; k < rows; k++) {
        const p = (k + scroll) / rows
        const y = horizon + (height - horizon) * Math.pow(p, 2.15)
        const alpha = 0.028 + p * 0.16
        ctx.strokeStyle = 'rgba(' + CYAN + ',' + alpha + ')'
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(width, y)
        ctx.stroke()
      }
      for (let i = -26; i <= 26; i++) {
        const bottomX = vanishX + i * (width * 0.11)
        const magenta = i % 6 === 0
        ctx.strokeStyle = magenta
          ? 'rgba(' + MAGENTA + ',0.10)'
          : 'rgba(' + CYAN + ',0.075)'
        ctx.beginPath()
        ctx.moveTo(vanishX + i * 3, horizon)
        ctx.lineTo(bottomX, height + 40)
        ctx.stroke()
      }
      drawGlowLine(0, horizon, width, horizon, CYAN, 0.22, 14)
      ctx.restore()

      // Rotating holographic HUD rings + slow radar sweep behind the card.
      const hubX = width / 2
      const hubY = height * 0.42
      const unit = Math.min(width, height)
      ctx.save()
      ctx.translate(hubX, hubY)
      const radarRadius = unit * 0.62
      const radarAngle = t * 0.32
      const radar = ctx.createRadialGradient(0, 0, 0, 0, 0, radarRadius)
      radar.addColorStop(0, 'rgba(' + CYAN + ',0.055)')
      radar.addColorStop(0.65, 'rgba(' + TEAL + ',0.03)')
      radar.addColorStop(1, 'rgba(' + CYAN + ',0)')
      ctx.fillStyle = radar
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.arc(0, 0, radarRadius, radarAngle, radarAngle + 0.5)
      ctx.closePath()
      ctx.fill()
      for (let ring = 0; ring < 3; ring++) {
        const radius = unit * (0.27 + ring * 0.105)
        const spin = t * (ring % 2 === 0 ? 0.12 : -0.09) + ring * 1.7
        ctx.save()
        ctx.rotate(spin)
        ctx.setLineDash(ring === 0 ? [2, 11] : [1, 17])
        ctx.lineWidth = 1
        ctx.strokeStyle = 'rgba(' + CYAN + ',' + (0.14 - ring * 0.03) + ')'
        ctx.beginPath()
        ctx.arc(0, 0, radius, 0, Math.PI * 2)
        ctx.stroke()
        // Highlighted arc sweeping around each ring (magenta accent).
        ctx.setLineDash([])
        ctx.lineWidth = 1.5
        ctx.strokeStyle = 'rgba(' + MAGENTA + ',' + (0.22 - ring * 0.05) + ')'
        ctx.beginPath()
        ctx.arc(0, 0, radius, spin * 0.6, spin * 0.6 + 0.55)
        ctx.stroke()
        // Radial tick marks.
        ctx.strokeStyle = 'rgba(' + TEAL + ',' + (0.10 - ring * 0.02) + ')'
        for (let tick = 0; tick < 36; tick++) {
          const a = (tick / 36) * Math.PI * 2
          const inner = radius - (tick % 9 === 0 ? 7 : 3)
          ctx.beginPath()
          ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner)
          ctx.lineTo(Math.cos(a) * radius, Math.sin(a) * radius)
          ctx.stroke()
        }
        ctx.restore()
      }
      ctx.restore()

      // Slow vertical hologram scan sweep.
      const sweepP = (Math.sin(t * 0.24) + 1) / 2
      const sweepY = height * 0.12 + sweepP * height * 0.72
      const sweep = ctx.createLinearGradient(0, sweepY - 60, 0, sweepY + 12)
      sweep.addColorStop(0, 'rgba(' + CYAN + ',0)')
      sweep.addColorStop(0.82, 'rgba(' + CYAN + ',0.05)')
      sweep.addColorStop(1, 'rgba(' + CYAN + ',0)')
      ctx.fillStyle = sweep
      ctx.fillRect(0, sweepY - 60, width, 72)
      drawGlowLine(0, sweepY, width, sweepY, TEAL, 0.1, 8)

      // Drifting data motes (twinkle + upward drift).
      ctx.save()
      for (const mote of motes) {
        const y = (mote.y - t * mote.speed) % (height + 20)
        const wrapped = y < 0 ? y + height + 20 : y
        const twinkle = 0.35 + 0.65 * Math.abs(Math.sin(t * 1.3 + mote.phase))
        const color = mote.hue === 'magenta' ? MAGENTA : CYAN
        ctx.fillStyle = 'rgba(' + color + ',' + (0.16 * twinkle) + ')'
        ctx.fillRect(mote.x, wrapped, mote.size, mote.size)
      }
      ctx.restore()

      // Occasional glitch: three thin neon slices jitter sideways for a blink.
      if (!reduced) {
        const cycle = t % 7.4
        if (cycle < 0.16) {
          ctx.save()
          ctx.globalCompositeOperation = 'screen'
          for (let g = 0; g < 3; g++) {
            const gy = seeded(Math.floor(t * 20) + g * 17) * height
            const gh = 1 + seeded(g * 31 + 5) * 4
            const shift = (seeded(g * 67 + 3) - 0.5) * 36
            ctx.fillStyle = g % 2 === 0 ? 'rgba(' + CYAN + ',0.10)' : 'rgba(' + MAGENTA + ',0.08)'
            ctx.fillRect(shift, gy, width, gh)
          }
          ctx.restore()
        }
      }

      // Top/bottom vignette so page content (card) stays the focus.
      const topFade = ctx.createLinearGradient(0, 0, 0, height * 0.28)
      topFade.addColorStop(0, 'rgba(4,6,12,0.85)')
      topFade.addColorStop(1, 'rgba(4,6,12,0)')
      ctx.fillStyle = topFade
      ctx.fillRect(0, 0, width, height * 0.28)
    }

    const frame = (now: number) => {
      if (!running) return
      if (!start) start = now
      const t = (now - start) / 1000
      if (now - last >= 22) {
        // ~45fps ceiling keeps the effect smooth without heating laptops.
        last = now
        if (visible) draw(t)
      }
      raf = window.requestAnimationFrame(frame)
    }

    const onVisibility = () => {
      visible = !document.hidden
      if (visible) last = 0
    }

    resize()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => resize())
      observer.observe(canvas)
      var cleanupObserver = () => observer.disconnect()
    }
    window.addEventListener('resize', resize)
    document.addEventListener('visibilitychange', onVisibility)

    if (reduced) {
      draw(0)
    } else {
      raf = window.requestAnimationFrame(frame)
    }

    return () => {
      running = false
      window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVisibility)
      if (typeof cleanupObserver === 'function') cleanupObserver()
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  )
}
