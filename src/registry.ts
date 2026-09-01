/**
 * dsh-session-bridge 自维护会话登记表：记录 bridge 创建 / 恢复 / 发现过的会话
 * （id、标题、cwd、workspace id、模型），落盘 ~/.dsh/session-bridge-registry.json，
 * 使按名查找离线会话更可靠（离线会话标题不在 header 中）。
 */
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface BridgeRecord {
  sessionId: string
  title?: string
  cwd?: string
  workspaceId?: string
  provider?: string
  model?: string
  createdAt: number
  updatedAt: number
  lastActivityAt?: number
  source: 'create' | 'resume' | 'discover'
}

const RECORD_FILE_NAME = 'session-bridge-registry.json'

function recordFilePath(): string {
  return dshHomePath(RECORD_FILE_NAME)
}

/** 解析登记表文件（缺失/损坏 → 空表）。 */
async function readRecords(): Promise<BridgeRecord[]> {
  try {
    const raw = await readFile(recordFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is BridgeRecord => {
      const record = entry as Record<string, unknown> | null
      return record !== null && typeof record === 'object' && typeof record.sessionId === 'string'
    }).map((record) => ({
      sessionId: record.sessionId,
      ...(typeof record.title === 'string' ? { title: record.title } : {}),
      ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
      ...(typeof record.workspaceId === 'string' ? { workspaceId: record.workspaceId } : {}),
      ...(typeof record.provider === 'string' ? { provider: record.provider } : {}),
      ...(typeof record.model === 'string' ? { model: record.model } : {}),
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
      ...(typeof record.lastActivityAt === 'number' ? { lastActivityAt: record.lastActivityAt } : {}),
      source: record.source === 'create' || record.source === 'resume' || record.source === 'discover' ? record.source : 'discover',
    }))
  } catch {
    return []
  }
}

export class BridgeRegistry {
  private records = new Map<string, BridgeRecord>()
  private loaded = false

  /** 加载登记表（幂等）。 */
  async load(): Promise<void> {
    if (this.loaded) return
    for (const record of await readRecords()) this.records.set(record.sessionId, record)
    this.loaded = true
  }

  /** 读取快照（自动加载，best-effort）。 */
  async get(sessionId: string): Promise<BridgeRecord | undefined> {
    await this.load().catch(() => undefined)
    return this.records.get(sessionId)
  }

  /** 全部记录（自动加载；返回顺序=登记顺序）。 */
  async all(): Promise<BridgeRecord[]> {
    await this.load().catch(() => undefined)
    return [...this.records.values()]
  }

  /** 新增 / 更新一条记录并落盘（best-effort，不阻塞调用方）。 */
  record(input: { sessionId: string; title?: string; cwd?: string; workspaceId?: string; provider?: string; model?: string; source: 'create' | 'resume' | 'discover' }): void {
    const now = Date.now()
    const prior = this.records.get(input.sessionId)
    const next: BridgeRecord = {
      sessionId: input.sessionId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      ...(prior !== undefined ? { lastActivityAt: prior.lastActivityAt } : {}),
      source: input.source,
    }
    this.records.set(input.sessionId, next)
    void this.persist().catch((error: unknown) => {
      console.warn('[dsh-session-bridge] registry write failed:', error instanceof Error ? error.message : String(error))
    })
  }

  /** 上报一次活动（发消息 / 等待 / 读取）。永不覆盖登记的别名 title。 */
  touch(sessionId: string, fields?: { cwd?: string; workspaceId?: string }): void {
    const prior = this.records.get(sessionId)
    if (prior === undefined) return
    this.records.set(sessionId, {
      ...prior,
      ...(fields?.cwd !== undefined ? { cwd: fields.cwd } : {}),
      ...(fields?.workspaceId !== undefined ? { workspaceId: fields.workspaceId } : {}),
      updatedAt: Date.now(),
      lastActivityAt: Date.now(),
    })
    void this.persist().catch((error: unknown) => {
      console.warn('[dsh-session-bridge] registry write failed:', error instanceof Error ? error.message : String(error))
    })
  }

  /** 落盘（best-effort）。 */
  async persist(): Promise<void> {
    const path = recordFilePath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify([...this.records.values()], null, 2), 'utf8')
  }
}
