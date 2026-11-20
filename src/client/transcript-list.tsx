/**
 * 转写列表的公共外壳：时间列 + 正文列，可选前置/后置插槽。
 *
 * 三个页面的行内容不同（今日带轨道与说话人、说话人识别带勾选框、离线导入只有时间+文本），
 * 但「时间列固定宽度、正文换行、行间细线、空状态」这套骨架是一样的，
 * 抽出来避免每个页面自己写一份 grid。
 */
import type { ReactElement, ReactNode } from 'react'

const BORDER = 'var(--dsw-alias-border-l1)'
const CAPTION = 'var(--dsw-alias-label-secondary)'
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'
const FS_XS = 'var(--pl-fs-xs)'
const FS_SM = 'var(--pl-fs-sm)'

export interface TranscriptRowView {
  key: string
  /** 左侧时间（已格式化）。 */
  time: string
  /** 正文。 */
  text: string
  /** 时间与正文之间的插槽，例如轨道标签或说话人 chip。 */
  before?: ReactNode
  /** 行尾插槽，例如「删这句」。 */
  after?: ReactNode
  /** 行首（勾选框）。 */
  leading?: ReactNode
  highlighted?: boolean
}

export function TranscriptList({ rows, empty, timeWidth = 64, edit }: {
  rows: TranscriptRowView[]
  empty: ReactNode
  /** 时间列宽度，按 HH:mm:ss 或 m:ss 调整。 */
  timeWidth?: number
  /** 传了就让正文可双击编辑；labels 用调用方的文案。 */
  edit?: {
    onSave: (row: TranscriptRowView, text: string) => Promise<boolean>
    hint: string
    saveLabel: string
    cancelLabel: string
    emptyLabel: string
  }
}): ReactElement {
  if (!rows.length) return <div style={{ fontSize: FS_XS, lineHeight: 1.6, color: CAPTION }}>{empty}</div>
  return (
    <div>
      {rows.map((row) => (
        <div
          key={row.key}
          style={{
            display: 'grid',
            gridTemplateColumns: `${row.leading ? '18px ' : ''}${timeWidth}px ${row.before ? 'auto ' : ''}minmax(0, 1fr) auto`,
            columnGap: 8,
            padding: '4px 0',
            borderBottom: `1px solid ${BORDER}`,
            alignItems: 'start',
            background: row.highlighted ? 'var(--pl-brand-soft)' : 'transparent',
          }}
        >
          {row.leading ?? null}
          <span style={{ fontFamily: MONO, fontSize: FS_XS, color: CAPTION, fontVariantNumeric: 'tabular-nums' }}>{row.time}</span>
          {row.before ?? null}
          {edit ? (
            <EditableLine
              text={row.text}
              onSave={(next) => edit.onSave(row, next)}
              hint={edit.hint}
              saveLabel={edit.saveLabel}
              cancelLabel={edit.cancelLabel}
              emptyLabel={edit.emptyLabel}
            />
          ) : (
            <span style={{ fontSize: FS_SM, lineHeight: '18px', wordBreak: 'break-word' }}>{row.text}</span>
          )}
          {row.after ?? <span />}
        </div>
      ))}
    </div>
  )
}
