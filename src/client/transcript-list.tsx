/**
 * 转写列表的公共外壳：时间列 + 正文列，可选前置/后置插槽。
 *
 * 三个页面的行内容不同（今日带轨道与说话人、说话人识别带勾选框、离线导入只有时间+文本），
 * 但「时间列固定宽度、正文换行、行间细线、空状态」这套骨架是一样的，
 * 抽出来避免每个页面自己写一份 grid。
 */
import { useState } from 'react'
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
  /**
   * 传了就让这一行的正文可双击编辑。
   * 用逐行闭包而不是按 key 反查：避免编辑态重渲染后对不上目标行（之前就是这么白屏的）。
   */
  onSaveText?: (next: string) => Promise<boolean>
}

const editHint = '双击可直接修改这句的正文（转写错了可以自己纠错）'
const editSave = '保存这句'
const editCancel = '取消'
const editEmpty = '内容不能为空'

export function TranscriptList({ rows, empty, timeWidth = 64 }: {
  rows: TranscriptRowView[]
  empty: ReactNode
  /** 时间列宽度，按 HH:mm:ss 或 m:ss 调整。 */
  timeWidth?: number
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
          {row.onSaveText ? (
            <EditableLine
              text={row.text}
              onSave={row.onSaveText}
              hint={editHint}
              saveLabel={editSave}
              cancelLabel={editCancel}
              emptyLabel={editEmpty}
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

/**
 * 可双击编辑的正文单元格：三个页面（今日 / 说话人识别 / 离线导入）共用同一套交互。
 * 保存动作由调用方提供（今日写 snippets.jsonl，导入写 imports/<id>/snippets.jsonl）。
 */
export function EditableLine({ text, onSave, hint, saveLabel, cancelLabel, emptyLabel }: {
  text: string
  onSave: (next: string) => Promise<boolean>
  hint: string
  saveLabel: string
  cancelLabel: string
  emptyLabel: string
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const [error, setError] = useState('')
  if (!editing) {
    return (
      <span
        style={{ minWidth: 0, fontSize: FS_SM, lineHeight: '18px', wordBreak: 'break-word', cursor: 'text' }}
        title={hint}
        onDoubleClick={() => { setDraft(text); setError(''); setEditing(true) }}
      >
        {text}
      </span>
    )
  }
  const commit = async (): Promise<void> => {
    const next = draft.trim()
    if (!next) { setError(emptyLabel); return }
    const ok = await onSave(next)
    if (ok) setEditing(false)
  }
  return (
    <span style={{ display: 'flex', gap: 6, alignItems: 'flex-start', minWidth: 0 }}>
      <textarea
        style={{
          flex: '1 1 auto', minHeight: 44, lineHeight: 1.5, resize: 'vertical',
          font: 'inherit', fontSize: FS_SM, padding: '4px 6px',
          border: `1px solid ${BORDER}`, borderRadius: RADIUS_CHIP,
          background: 'transparent', color: 'inherit', outline: 'none',
        }}
        value={draft}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void commit()
          if (event.key === 'Escape') setEditing(false)
        }}
      />
      <button type="button" style={{ font: 'inherit', fontSize: FS_XS, padding: '2px 8px', border: `1px solid ${BORDER}`, borderRadius: RADIUS_CHIP, cursor: 'pointer', background: 'transparent', color: 'inherit' }} onClick={() => void commit()}>
        {saveLabel}
      </button>
      <button type="button" style={{ font: 'inherit', fontSize: FS_XS, padding: '2px 8px', border: `1px solid ${BORDER}`, borderRadius: RADIUS_CHIP, cursor: 'pointer', background: 'transparent', color: 'inherit' }} onClick={() => setEditing(false)}>
        {cancelLabel}
      </button>
      {error ? <span style={{ fontSize: FS_XS, color: '#c0392b' }}>{error}</span> : null}
    </span>
  )
}
