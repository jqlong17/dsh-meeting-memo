/**
 * Browser half of `dsh-meeting-memo`: one right-sidebar tab "会议纪要" with
 * two internal tabs (今日 / 纪要). Data is read/written through the Host RPC
 * route; the bundle only requires `react`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots/client'

import { Panel } from './panel.tsx'
import { createRpc } from './rpc.ts'
import { demoResponse } from './demo.ts'
import { NS, en, zh } from './labels.ts'

/** Tab implementation identity; also the keyed dispatch key for the body. */
export const PANEL_ID = 'dsh-meeting-memo'
/** Tab kind, used by `sidebarRight.openTab(kind)`. */
export const TAB_KIND = 'meeting-minutes'

export const inject = ['slots', 'sidebarRightTabs', 'locale'] as const

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'meeting-minutes: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: PANEL_ID,
    kind: TAB_KIND,
    priority: 'extension',
    title: () => t('tab.title'),
    guide: [{
      id: 'meeting-minutes',
      order: 57,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
    }],
  }), 'meeting-minutes: tab type')

  const rpc = createRpc(undefined, demoResponse)

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ rpc }),
  }, Panel)), 'meeting-minutes: tab body')
}
