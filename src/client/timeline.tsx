/**
 * Reusable timeline chart for the meeting-minutes panel.
 *
 * A single self-contained SVG component: 5-minute density bars, hourly ticks,
 * pointer drag selection, click-to-select a one-hour window, and a hover
 * readout. No chart library — the browser bundle may only require `react`.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react'

const FG = 'var(--dsw-alias-label-primary, inherit)'
const FG3 = 'var(--dsw-alias-label-secondary, inherit)'
const CAPTION = 'var(--dsw-alias-label-secondary, rgba(0,0,0,0.55))'
const BORDER = 'var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12))'
const ACCENT = 'var(--dsw-alias-brand-primary, #4a63e7)'
const SUCCESS = 'var(--dsw-alias-state-success-primary, #1a7f37)'
const TOOLTIP_BG = 'var(--dsw-alias-bg-overlay, rgba(20, 22, 28, 0.92))'
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'

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
    start,
    end,
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
  const [hover, setHover] = useState<number | null>(null)

  const span = Math.max(1, end - start)
  const bin = Math.max(1, binMinutes)
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
    for (let minute = Math.ceil(start / 60) * 60; minute <= end; minute += 60) ticks.push(minute)
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
        <text x={PADDING.left} y={13} fontSize={10} fill={CAPTION}>
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
            <text x={PADDING.left - 6} y={yOf(value) + 3} fontSize={9} fill={CAPTION} textAnchor="end">
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
          fill={ACCENT}
          opacity={0.1}
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
                fill={ACCENT}
                opacity={0.3}
                pointerEvents="none"
              />
            )
          }
          const top = yOf(value)
          return (
            <rect
              key={index}
              x={x + 0.3}
              y={top}
              width={barWidth}
              height={Math.max(1, baseY - top)}
              rx={Math.min(2, barWidth / 2)}
              fill={ACCENT}
              opacity={0.35 + value * 0.6}
              pointerEvents="none"
            />
          )
        })}

        <text x={selX} y={PADDING.top - 8} fontSize={9.5} fill={FG} fontFamily={MONO} pointerEvents="none">
          {formatTime(selStart)}
        </text>
        <text
          x={selX + selW}
          y={PADDING.top - 8}
          fontSize={9.5}
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
              fontSize={9}
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
            <text x={xOf(now) + 3} y={PADDING.top + 9} fontSize={8.5} fill={ACCENT}>
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
              <text x={PADDING.left - 6} y={laneY + 9} fontSize={8.5} fill={CAPTION} textAnchor="end">
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
                    <text x={x + 5} y={laneY + 8.5} fontSize={8.5} fill={SUCCESS} pointerEvents="none">
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
            borderRadius: 6,
            background: TOOLTIP_BG,
            color: '#fff',
            fontSize: 10.5,
            lineHeight: 1.35,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            boxShadow: '0 4px 14px rgba(0,0,0,0.22)',
          }}
        >
          <div style={{ fontFamily: MONO }}>{formatTime(hoverFrom)}–{formatTime(hoverTo)}</div>
          <div style={{ opacity: 0.85 }}>
            {Math.round(hoverValue * 100)}% · {captured[hoverIndex] ? labels.speech : labels.gap}
          </div>
        </div>
      ) : null}
    </div>
  )
}
