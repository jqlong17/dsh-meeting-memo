/**
 * Editable minutes-writing skills. The system prompt is not hard-coded: users
 * can keep several ways of writing minutes and pick one before generating.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { SYSTEM_PROMPT } from './ai.ts'

export interface MinutesSkill {
  id: string
  name: string
  /** One line shown under the name in the picker. */
  description: string
  prompt: string
  builtin?: boolean
  updatedAt: string
}

export interface SkillsState {
  selectedId: string
  skills: MinutesSkill[]
}

const FILE = 'skills.json'

export const BUILTIN_SKILL_ID = 'builtin-minutes'

export function builtinSkill(): MinutesSkill {
  return {
    id: BUILTIN_SKILL_ID,
    name: '会议纪要',
    description: '内置写法：背景与目标 + 核心结论 + 3–6 条要点 + TODO。',
    prompt: SYSTEM_PROMPT,
    builtin: true,
    updatedAt: '',
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function writeAtomic(file: string, content: string): void {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

function normalizeSkill(raw: unknown): MinutesSkill | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : ''
  if (!prompt) return null
  const id = String(record.id ?? '').trim()
  if (!id) return null
  return {
    id,
    name: String(record.name ?? '').trim() || '未命名技能',
    description: String(record.description ?? '').trim(),
    prompt,
    ...(record.builtin === true ? { builtin: true } : {}),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  }
}

export function readSkills(home: string): SkillsState {
  const file = path.join(home, FILE)
  const fallback: SkillsState = { selectedId: BUILTIN_SKILL_ID, skills: [builtinSkill()] }
  if (!existsSync(file)) return fallback
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const list = Array.isArray(parsed.skills)
      ? parsed.skills.map(normalizeSkill).filter((item): item is MinutesSkill => item !== null)
      : []
    if (!list.length) return fallback
    const selectedId = list.some((item) => item.id === parsed.selectedId)
      ? String(parsed.selectedId)
      : list[0].id
    return { selectedId, skills: list }
  } catch {
    return fallback
  }
}

export function writeSkills(home: string, state: SkillsState): SkillsState {
  const list = state.skills.length ? state.skills : [builtinSkill()]
  const selectedId = list.some((item) => item.id === state.selectedId) ? state.selectedId : list[0].id
  writeAtomic(path.join(home, FILE), `${JSON.stringify({ version: 1, selectedId, skills: list }, null, 2)}\n`)
  return { selectedId, skills: list }
}

export function saveSkill(home: string, raw: { id?: string; name?: string; description?: string; prompt?: string; select?: boolean }): SkillsState {
  const state = readSkills(home)
  const prompt = String(raw.prompt ?? '').trim()
  if (!prompt) throw new Error('技能写法不能为空')
  const now = new Date().toISOString()
  const id = String(raw.id ?? '').trim() || `skill-${randomUUID()}`
  const next: MinutesSkill = {
    id,
    name: String(raw.name ?? '').trim() || '未命名技能',
    description: String(raw.description ?? '').trim(),
    prompt,
    ...(state.skills.find((item) => item.id === id)?.builtin ? { builtin: true } : {}),
    updatedAt: now,
  }
  const skills = state.skills.some((item) => item.id === id)
    ? state.skills.map((item) => (item.id === id ? next : item))
    : [...state.skills, next]
  return writeSkills(home, { selectedId: raw.select || !state.skills.length ? id : state.selectedId, skills })
}

export function deleteSkill(home: string, id: string): SkillsState {
  const state = readSkills(home)
  const skills = state.skills.filter((item) => item.id !== id)
  if (!skills.length) throw new Error('至少保留一个写法')
  return writeSkills(home, { selectedId: state.selectedId === id ? skills[0].id : state.selectedId, skills })
}

export function selectSkill(home: string, id: string): SkillsState {
  const state = readSkills(home)
  if (!state.skills.some((item) => item.id === id)) throw new Error('没有这个写法')
  return writeSkills(home, { ...state, selectedId: id })
}

/** The skill used for a generation: explicit id, else the selected one, else builtin. */
export function resolveSkill(home: string, id?: string): MinutesSkill {
  const state = readSkills(home)
  const wanted = id?.trim() || state.selectedId
  return state.skills.find((skill) => skill.id === wanted)
    ?? state.skills.find((skill) => skill.id === state.selectedId)
    ?? state.skills[0]
    ?? builtinSkill()
}
