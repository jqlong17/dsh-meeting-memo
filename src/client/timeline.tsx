/**
 * Reusable timeline chart for the meeting-minutes panel.
 *
 * A single self-contained SVG component: 5-minute density bars, hourly ticks,
 * pointer drag selection, click-to-select a one-hour window, and a hover
 * readout. No chart library — the browser bundle may only require `react`.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react'

const FG = 'var(--dsw-alias-label-primary)'
const FG3 = 'var(--dsw-alias-label-secondary)'
const CAPTION = 'var(--dsw-alias-label-secondary)'
const BORDER = 'var(--dsw-alias-border-l1)'
const ACCENT = 'var(--pl-brand)'
const ACCENT_SOFT = 'var(--pl-brand-soft)'
// 未选中数据用淡蓝，不用 fill-l2（该 token 未定义，SVG 会 fallback 成黑）
const NEUTRAL_BAR = 'var(--pl-brand-soft)'
// 选区底色按规范取品牌蓝 10%，和未选中数据的淡蓝区分开
const SELECTION_WASH = 'color-mix(in srgb, var(--pl-brand) 10%, transparent)'
const SUCCESS = 'var(--dsw-alias-state-success-primary)'
const TOOLTIP_BG = 'var(--dsw-alias-bg-layer-1)'
const CARD_BORDER = 'var(--dsw-alias-border-l2)'
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'

const FS = {
  xs: 'var(--pl-fs-xs)',
  sm: 'var(--pl-fs-sm)',
} as const

const RADIUS_CHIP = 'var(--pl-radius-chip)'
const RADIUS_PILL = 'var(--pl-radius-pill)'

export interface TimelineBucket {
  /** Minute of local day. */
  m: number
  /** VAD-gated speech seconds in that minute. */
  s: number
}

export interface TimelineRange {
  start: number
  end: number
}

/** One existing minutes entry drawn as a strip under the axis. */
export interface TimelineInterval {
  start: number
  end: number
  label?: string
}

export interface TimelineChartLabels {
  density: string
  hint: string
  gap: string
  speech: string
  now: string
}

export interface TimelineChartProps {
  buckets: TimelineBucket[]
  /** Window start, minutes of day. */
  start: number
  /** Window end, minutes of day. */
  end: number
  selection: TimelineRange
  /** Existing minutes entries, drawn as strips below the axis. */
  intervals?: TimelineInterval[]
  /** Left-gutter caption for the interval lane, e.g. `纪要`. */
  intervalsLabel?: string
  /** Current clock, minutes of day; drawn as a marker when inside the window. */
  now?: number | null
  binMinutes?: number
  height?: number
  labels: TimelineChartLabels
  formatTime: (minute: number) => string
  /** Live selection while dragging (cheap, parent re-renders). */
  onDraft?: (range: TimelineRange) => void
  /** Final selection on pointer-up; parent persists it. */
  onCommit?: (range: TimelineRange) => void
}

const PADDING = { left: 36, right: 12, top: 30, bottom: 24 }

function useElementWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(320)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = (): void => {
      const next = Math.round(element.clientWidth)
      if (next > 0) setWidth((prev) => (Math.abs(prev - next) >= 2 ? next : prev))
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function TimelineChart(props: TimelineChartProps) {
  const {
    buckets,
    start: boundsStart,
    end: boundsEnd,
    selection,
    intervals = [],
    intervalsLabel,
    now,
    binMinutes = 5,
    height = 196,
    labels,
    formatTime,
    onDraft,
    onCommit,
  } = props
  const [wrapperRef, width] = useElementWidth()
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<{ anchor: number; moved: boolean; pointerId: number } | null>(null)
  const scrubRef = useRef<{ pointerId: number; originX: number; originStart: number; span: number } | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [view, setView] = useState({ start: boundsStart, end: boundsEnd })
  const viewRef = useRef(view)
  viewRef.current = view

  useEffect(() => {
    setView({ start: boundsStart, end: boundsEnd })
  }, [boundsStart, boundsEnd])

  useEffect(() => {
    const element = wrapperRef.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      if (scrubRef.current) return
      const chart = svgRef.current?.getBoundingClientRect()
      if (!chart || event.clientY > chart.bottom) return
      event.preventDefault()
      const rect = svgRef.current?.getBoundingClientRect()
      const current = viewRef.current
      const spanNow = Math.max(1, current.end - current.start)
      const plotW = Math.max(20, (rect?.width ?? width) - PADDING.left - PADDING.right)
      const ratio = rect
        ? clamp((event.clientX - rect.left - PADDING.left) / plotW, 0, 1)
        : 0.5
      const anchor = current.start + ratio * spanNow
      const boundsSpan = Math.max(1, boundsEnd - boundsStart)
      const nextSpan = clamp(spanNow * (event.deltaY < 0 ? 0.8 : 1.25), 15, boundsSpan)
      let nextStart = anchor - ratio * nextSpan
      let nextEnd = nextStart + nextSpan
      if (nextStart < boundsStart) {
        nextStart = boundsStart
        nextEnd = boundsStart + nextSpan
      }
      if (nextEnd > boundsEnd) {
        nextEnd = boundsEnd
        nextStart = Math.max(boundsStart, boundsEnd - nextSpan)
      }
      setView({ start: nextStart, end: nextEnd })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [boundsStart, boundsEnd, width, wrapperRef])

  const start = view.start
  const end = view.end
  const span = Math.max(1, end - start)
  const bin = span <= 90 ? 1 : span <= 240 ? Math.min(binMinutes, 2) : Math.max(1, binMinutes)
  const binCount = Math.max(1, Math.ceil(span / bin))

  const { density, captured } = useMemo(() => {
    const sums = new Float64Array(binCount)
    const flags = new Uint8Array(binCount)
    for (const bucket of buckets) {
      if (!Number.isFinite(bucket.m) || bucket.m < start || bucket.m >= end) continue
      const index = Math.min(binCount - 1, Math.floor((bucket.m - start) / bin))
      sums[index] += Math.max(0, bucket.s)
      flags[index] = 1
    }
    const values = new Float64Array(binCount)
    for (let index = 0; index < binCount; index += 1) {
      values[index] = Math.min(1, sums[index] / (bin * 60))
    }
    return { density: values, captured: flags }
  }, [buckets, start, end, bin, binCount])

  const plotW = Math.max(20, width - PADDING.left - PADDING.right)
  const plotH = Math.max(20, height - PADDING.top - PADDING.bottom)
  const baseY = PADDING.top + plotH
  const visibleIntervals = intervals.filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > start && interval.start < end)
  const laneY = baseY + 18
  const svgHeight = height + (visibleIntervals.length ? 10 : 0)
  const xOf = (minute: number): number => PADDING.left + ((minute - start) / span) * plotW
  const yOf = (value: number): number => PADDING.top + (1 - clamp(value, 0, 1)) * plotH

  const hourTicks = useMemo(() => {
    const ticks: number[] = []
    const step = span > 360 ? 60 : span > 120 ? 30 : span > 45 ? 10 : 5
    for (let minute = Math.ceil(start / step) * step; minute <= end; minute += step) ticks.push(minute)
    return ticks
  }, [start, end])

  const labelEvery = plotW >= 560 ? 1 : 2
  const selStart = clamp(Math.min(selection.start, selection.end), start, end)
  const selEnd = clamp(Math.max(selection.start, selection.end), start, end)
  const selX = xOf(selStart)
  const selW = Math.max(1, xOf(selEnd) - selX)

  const minuteAt = (clientX: number): number => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return start
    const ratio = clamp((clientX - rect.left - PADDING.left) / plotW, 0, 1)
    return Math.round((start + ratio * span) * 10) / 10
  }

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return
    const minute = minuteAt(event.clientX)
    dragRef.current = { anchor: minute, moved: false, pointerId: event.pointerId }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is optional; dragging still works while inside the SVG.
    }
    setHover(minute)
    onDraft?.({ start: minute, end: minute })
  }

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const minute = minuteAt(event.clientX)
    const drag = dragRef.current
    if (drag) {
      if (Math.abs(minute - drag.anchor) >= 0.5) drag.moved = true
      onDraft?.({ start: Math.min(drag.anchor, minute), end: Math.max(drag.anchor, minute) })
    }
    setHover(minute)
  }

  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(drag.pointerId)
    } catch {
      // Already released.
    }
    const minute = minuteAt(event.clientX)
    let range: TimelineRange
    if (!drag.moved) {
      const half = 30
      const from = Math.max(start, minute - half)
      const to = Math.min(end, minute + half)
      range = { start: from, end: to > from ? to : Math.min(end, from + 60) }
    } else {
      const from = Math.min(drag.anchor, minute)
      const to = Math.max(drag.anchor, minute)
      range = { start: from, end: Math.max(to, from + 1) }
    }
    onCommit?.(range)
  }

  const handlePointerCancel = (): void => {
    dragRef.current = null
    setHover(null)
  }

  const hoverIndex = hover === null ? -1 : Math.min(binCount - 1, Math.floor((hover - start) / bin))
  const hoverValue = hoverIndex >= 0 ? density[hoverIndex] : 0
  const hoverFrom = start + Math.max(0, hoverIndex) * bin
  const hoverTo = Math.min(end, hoverFrom + bin)
  const tooltipLeft = hover === null ? 0 : clamp(xOf(hover), 64, Math.max(64, width - 64))
  const rootStyle: CSSProperties = { position: 'relative', width: '100%', userSelect: 'none' }

  return (
    <div ref={wrapperRef} style={rootStyle} data-meeting-timeline="density">
      <svg
        ref={svgRef}
        width={width}
        height={svgHeight}
        viewBox={`0 0 ${width} ${svgHeight}`}
        role="img"
        aria-label={`${labels.density} ${formatTime(start)}–${formatTime(end)}`}
        style={{ display: 'block', touchAction: 'none', cursor: 'crosshair' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={() => {
          if (!dragRef.current) setHover(null)
        }}
      >
        <text x={PADDING.left} y={13} fontSize={FS.xs} fill={CAPTION}>
          {labels.density}
          <tspan dx={6} opacity={0.7}>{labels.hint}</tspan>
        </text>

        {[0, 0.5, 1].map((value) => (
          <g key={value}>
            <line
              x1={PADDING.left}
              x2={PADDING.left + plotW}
              y1={yOf(value)}
              y2={yOf(value)}
              stroke={BORDER}
              strokeWidth={1}
              strokeDasharray={value === 0 ? undefined : '2 4'}
              opacity={value === 0 ? 0.9 : 0.55}
            />
            <text x={PADDING.left - 6} y={yOf(value) + 3} fontSize={FS.xs} fill={CAPTION} textAnchor="end">
              {value === 0 ? '0' : `${value * 100}%`}
            </text>
          </g>
        ))}

        {hourTicks.map((minute) => (
          <line
            key={minute}
            x1={xOf(minute)}
            x2={xOf(minute)}
            y1={PADDING.top}
            y2={baseY}
            stroke={BORDER}
            strokeWidth={1}
            opacity={0.5}
          />
        ))}

        {visibleIntervals.map((interval, index) => {
          const from = clamp(Math.min(interval.start, interval.end), start, end)
          const to = clamp(Math.max(interval.start, interval.end), start, end)
          const x = xOf(from)
          const bandWidth = Math.max(2, xOf(to) - x)
          return (
            <g key={`band-${index}-${from}`} pointerEvents="none">
              <rect
                x={x}
                y={PADDING.top}
                width={bandWidth}
                height={plotH}
                fill={SUCCESS}
                fillOpacity={0.08}
              />
              <line
                x1={x}
                x2={x}
                y1={PADDING.top}
                y2={baseY}
                stroke={SUCCESS}
                strokeOpacity={0.32}
                strokeWidth={1}
                strokeDasharray="2 3"
              />
              <line
                x1={x + bandWidth}
                x2={x + bandWidth}
                y1={PADDING.top}
                y2={baseY}
                stroke={SUCCESS}
                strokeOpacity={0.32}
                strokeWidth={1}
                strokeDasharray="2 3"
              />
            </g>
          )
        })}

        <rect
          x={selX}
          y={PADDING.top}
          width={selW}
          height={plotH}
          fill={SELECTION_WASH}
          pointerEvents="none"
        />
        <line x1={selX} x2={selX} y1={PADDING.top} y2={baseY} stroke={ACCENT} strokeWidth={1.2} pointerEvents="none" />
        <line x1={selX + selW} x2={selX + selW} y1={PADDING.top} y2={baseY} stroke={ACCENT} strokeWidth={1.2} pointerEvents="none" />

        {Array.from({ length: binCount }, (_, index) => {
          const value = density[index]
          const x = PADDING.left + (index * bin / span) * plotW
          const barWidth = Math.max(0.8, (bin / span) * plotW - 0.7)
          if (!captured[index]) {
            return (
              <rect
                key={index}
                x={x + 0.3}
                y={baseY - 3}
                width={barWidth}
                height={3}
                rx={1.5}
                fill={BORDER}
                opacity={0.7}
                pointerEvents="none"
              />
            )
          }
          if (value <= 0.002) {
            return (
              <rect
                key={index}
                x={x + 0.3}
                y={baseY - 2}
                width={barWidth}
                height={2}
                rx={1}
                fill={NEUTRAL_BAR}
                opacity={0.8}
                pointerEvents="none"
              />
            )
          }
          const top = yOf(value)
          // 数据本体一律中性色，只有落在选区内的柱才上品牌色。
          const binStart = start + index * bin
          const inSelection = binStart + bin > selStart && binStart < selEnd
          return (
            <rect
              key={index}
              x={x + 0.3}
              y={top}
              width={barWidth}
              height={Math.max(1, baseY - top)}
              rx={Math.min(2, barWidth / 2)}
              fill={inSelection ? ACCENT : NEUTRAL_BAR}
              opacity={inSelection ? 0.9 : 0.85}
              pointerEvents="none"
            />
          )
        })}

        <text x={selX} y={PADDING.top - 8} fontSize={FS.xs} fill={FG} fontFamily={MONO} pointerEvents="none">
          {formatTime(selStart)}
        </text>
        <text
          x={selX + selW}
          y={PADDING.top - 8}
          fontSize={FS.xs}
          fill={FG}
          fontFamily={MONO}
          textAnchor="end"
          pointerEvents="none"
        >
          {formatTime(selEnd)}
        </text>

        {hourTicks.map((minute, index) => {
          const even = (minute / 60) % labelEvery === 0
          const last = minute === hourTicks[hourTicks.length - 1]
          if (!even && !last) return null
          return (
            <text
              key={`label-${minute}`}
              x={xOf(minute)}
              y={baseY + 13}
              fontSize={FS.xs}
              fill={FG3}
              textAnchor={index === 0 ? 'start' : last ? 'end' : 'middle'}
              opacity={0.85}
              pointerEvents="none"
            >
              {formatTime(minute)}
            </text>
          )
        })}

        {typeof now === 'number' && Number.isFinite(now) && now >= start && now <= end ? (
          <g pointerEvents="none">
            <line
              x1={xOf(now)}
              x2={xOf(now)}
              y1={PADDING.top}
              y2={baseY}
              stroke={ACCENT}
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.75}
            />
            <text x={xOf(now) + 3} y={PADDING.top + 9} fontSize={FS.xs} fill={ACCENT}>
              {labels.now}
            </text>
          </g>
        ) : null}

        {visibleIntervals.length ? (
          <g>
            <line
              x1={PADDING.left}
              x2={PADDING.left + plotW}
              y1={laneY + 13}
              y2={laneY + 13}
              stroke={BORDER}
              strokeWidth={1}
              opacity={0.5}
              pointerEvents="none"
            />
            {intervalsLabel ? (
              <text x={PADDING.left - 6} y={laneY + 9} fontSize={FS.xs} fill={CAPTION} textAnchor="end">
                {intervalsLabel}
              </text>
            ) : null}
            {visibleIntervals.map((interval, index) => {
              const from = clamp(Math.min(interval.start, interval.end), start, end)
              const to = clamp(Math.max(interval.start, interval.end), start, end)
              const x = xOf(from)
              const intervalWidth = Math.max(7, xOf(to) - x)
              const label = interval.label?.trim() ?? ''
              const showLabel = intervalWidth >= 46 && label.length > 0
              return (
                <g key={`interval-${index}-${from}`}>
                  <title>{`${formatTime(from)}–${formatTime(to)}${label ? ` · ${label}` : ''}`}</title>
                  <rect
                    x={x}
                    y={laneY}
                    width={intervalWidth}
                    height={12}
                    rx={6}
                    fill={SUCCESS}
                    fillOpacity={0.18}
                    stroke={SUCCESS}
                    strokeOpacity={0.75}
                    strokeWidth={1}
                  />
                  {showLabel ? (
                    <text x={x + 5} y={laneY + 8.5} fontSize={FS.xs} fill={SUCCESS} pointerEvents="none">
                      {label.length > 13 ? `${label.slice(0, 12)}…` : label}
                    </text>
                  ) : null}
                </g>
              )
            })}
          </g>
        ) : null}
      </svg>

      {hover !== null && hoverIndex >= 0 ? (
        <div
          style={{
            position: 'absolute',
            left: tooltipLeft,
            top: 16,
            transform: 'translateX(-50%)',
            padding: '4px 7px',
            borderRadius: RADIUS_CHIP,
            background: TOOLTIP_BG,
            color: FG,
            border: `1px solid ${CARD_BORDER}`,
            fontSize: FS.xs,
            lineHeight: 1.45,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          <div style={{ fontFamily: MONO }}>{formatTime(hoverFrom)}–{formatTime(hoverTo)}</div>
          <div style={{ opacity: 0.85 }}>
            {Math.round(hoverValue * 100)}% · {captured[hoverIndex] ? labels.speech : labels.gap}
          </div>
        </div>
      ) : null}
      <TimelineScrubber
        width={plotW}
        inset={PADDING.left}
        boundsStart={boundsStart}
        boundsEnd={boundsEnd}
        viewStart={start}
        viewEnd={end}
        formatTime={formatTime}
        onPan={(nextStart, lockedSpan) => {
          const spanNow = Math.max(1, lockedSpan)
          const maxStart = Math.max(boundsStart, boundsEnd - spanNow)
          const clamped = clamp(nextStart, boundsStart, maxStart)
          setView({ start: clamped, end: clamped + spanNow })
        }}
        scrubRef={scrubRef}
      />
    </div>
  )
}

function TimelineScrubber(props: {
  width: number
  inset: number
  boundsStart: number
  boundsEnd: number
  viewStart: number
  viewEnd: number
  formatTime: (minute: number) => string
  onPan: (start: number, span: number) => void
  scrubRef: { current: { pointerId: number; originX: number; originStart: number; span: number } | null }
}): ReactElement {
  const boundsSpan = Math.max(1, props.boundsEnd - props.boundsStart)
  const span = Math.max(1, props.viewEnd - props.viewStart)
  const widthPct = Math.min(100, Math.max(0, (span / boundsSpan) * 100))
  const leftPct = Math.min(100 - widthPct, Math.max(0, ((props.viewStart - props.boundsStart) / boundsSpan) * 100))
  const thumbWidth = `${widthPct}%`
  const thumbLeft = `${leftPct}%`
  const trackRef = useRef<HTMLDivElement | null>(null)

  const minuteAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return props.boundsStart
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1)
    return props.boundsStart + ratio * boundsSpan
  }

  return (
    <div style={{ margin: '6px 0 2px 0', marginLeft: props.inset, width: props.width, boxSizing: 'border-box' }}>
      <div
        ref={trackRef}
        style={{
          position: 'relative',
          height: 14,
          borderRadius: RADIUS_PILL,
          background: ACCENT_SOFT,
          border: `1px solid ${BORDER}`,
          cursor: 'pointer',
          overflow: 'hidden',
          boxSizing: 'border-box',
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          const target = event.target as HTMLElement
          if (target.dataset.thumb === '1') return
          props.onPan(minuteAt(event.clientX) - span / 2, span)
        }}
      >
        <div
          data-thumb="1"
          title={`${props.formatTime(props.viewStart)}–${props.formatTime(props.viewEnd)}`}
          style={{
            position: 'absolute',
            left: thumbLeft,
            top: 1,
            width: thumbWidth,
            height: 10,
            borderRadius: RADIUS_CHIP,
            background: ACCENT,
            opacity: 0.9,
            cursor: 'grab',
            touchAction: 'none',
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.stopPropagation()
            props.scrubRef.current = {
              pointerId: event.pointerId,
              originX: event.clientX,
              originStart: props.viewStart,
              span,
            }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const drag = props.scrubRef.current
            if (!drag || drag.pointerId !== event.pointerId) return
            const rect = trackRef.current?.getBoundingClientRect()
            if (!rect || rect.width <= 0) return
            const delta = ((event.clientX - drag.originX) / rect.width) * boundsSpan
            props.onPan(drag.originStart + delta, drag.span)
          }}
          onPointerUp={(event) => {
            if (props.scrubRef.current?.pointerId === event.pointerId) props.scrubRef.current = null
          }}
          onPointerCancel={() => { props.scrubRef.current = null }}
        />
      </div>
    </div>
  )
}
