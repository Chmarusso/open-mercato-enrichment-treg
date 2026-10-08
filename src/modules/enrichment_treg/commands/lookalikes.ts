import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  registerCommand,
  type CommandHandler,
  type CommandRuntimeContext,
} from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { EnrichmentLookalike } from '../data/entities'
import type { LookalikeStatus } from '../lib/constants'

type Scope = { tenantId: string; organizationId: string }

export type MarkLookalikeImportedInput = Scope & {
  lookalikeId: string
  companyId: string
  userId: string
}

export type DismissLookalikeInput = Scope & {
  lookalikeId: string
  userId: string
}

type LookalikeSnapshot = {
  status: LookalikeStatus
  crmCompanyId: string | null
  importedAt: string | null
  importedByUserId: string | null
  dismissedAt: string | null
  dismissedByUserId: string | null
}

type LookalikeResult = { lookalikeId: string; status: LookalikeStatus }

export const LOOKALIKE_RESOURCE_KIND = 'enrichment_treg.lookalike'

function resolveEm(ctx: CommandRuntimeContext): EntityManager {
  return ((ctx.container as AwilixContainer).resolve('em') as EntityManager).fork()
}

async function loadLookalike(em: EntityManager, lookalikeId: string, scope: Scope): Promise<EnrichmentLookalike | null> {
  return findOneWithDecryption(
    em,
    EnrichmentLookalike,
    { id: lookalikeId, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    undefined,
    scope,
  )
}

async function loadForUpdate(
  em: EntityManager,
  input: Scope & { lookalikeId: string },
  ctx: CommandRuntimeContext,
): Promise<EnrichmentLookalike> {
  const lookalike = await loadLookalike(em, input.lookalikeId, input)
  if (!lookalike) throw new CrudHttpError(404, { error: 'lookalike_not_found' })
  enforceCommandOptimisticLock({
    resourceKind: LOOKALIKE_RESOURCE_KIND,
    resourceId: lookalike.id,
    current: lookalike.updatedAt,
    request: ctx.request ?? null,
  })
  return lookalike
}

function snapshotLookalike(lookalike: EnrichmentLookalike): LookalikeSnapshot {
  return {
    status: lookalike.status,
    crmCompanyId: lookalike.crmCompanyId ?? null,
    importedAt: lookalike.importedAt ? lookalike.importedAt.toISOString() : null,
    importedByUserId: lookalike.importedByUserId ?? null,
    dismissedAt: lookalike.dismissedAt ? lookalike.dismissedAt.toISOString() : null,
    dismissedByUserId: lookalike.dismissedByUserId ?? null,
  }
}

function restoreSnapshot(lookalike: EnrichmentLookalike, snapshot: LookalikeSnapshot): void {
  lookalike.status = snapshot.status
  lookalike.crmCompanyId = snapshot.crmCompanyId
  lookalike.importedAt = snapshot.importedAt ? new Date(snapshot.importedAt) : null
  lookalike.importedByUserId = snapshot.importedByUserId
  lookalike.dismissedAt = snapshot.dismissedAt ? new Date(snapshot.dismissedAt) : null
  lookalike.dismissedByUserId = snapshot.dismissedByUserId
}

async function prepareSnapshot(input: Scope & { lookalikeId: string }, ctx: CommandRuntimeContext) {
  const lookalike = await loadLookalike(resolveEm(ctx), input.lookalikeId, input)
  return lookalike ? { before: snapshotLookalike(lookalike) } : null
}

async function undoFromSnapshot(
  input: Scope & { lookalikeId: string },
  ctx: CommandRuntimeContext,
  snapshotBefore: unknown,
): Promise<void> {
  const before = snapshotBefore as LookalikeSnapshot | null | undefined
  if (!before) return
  const em = resolveEm(ctx)
  const lookalike = await loadLookalike(em, input.lookalikeId, input)
  if (!lookalike) return
  restoreSnapshot(lookalike, before)
  await em.flush()
}

const markImportedCommand: CommandHandler<MarkLookalikeImportedInput, LookalikeResult> = {
  id: 'enrichment_treg.lookalikes.mark_imported',
  isUndoable: true,
  prepare: prepareSnapshot,
  async execute(input, ctx) {
    const em = resolveEm(ctx)
    const lookalike = await loadForUpdate(em, input, ctx)
    if (lookalike.status !== 'new') throw new CrudHttpError(409, { error: 'record_not_applicable' })
    lookalike.status = 'imported'
    lookalike.crmCompanyId = input.companyId
    lookalike.importedAt = new Date()
    lookalike.importedByUserId = input.userId
    await em.flush()
    return { lookalikeId: lookalike.id, status: lookalike.status }
  },
  buildLog({ input, result, snapshots }) {
    return {
      actionLabel: 'enrichment_treg.lookalikes.mark_imported',
      resourceKind: LOOKALIKE_RESOURCE_KIND,
      resourceId: result.lookalikeId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      relatedResourceKind: 'customers.company',
      relatedResourceId: input.companyId,
      snapshotBefore: snapshots.before ?? null,
      payload: { companyId: input.companyId },
    }
  },
  async undo({ input, ctx, logEntry }) {
    await undoFromSnapshot(input, ctx, logEntry.snapshotBefore)
  },
}

const dismissCommand: CommandHandler<DismissLookalikeInput, LookalikeResult> = {
  id: 'enrichment_treg.lookalikes.dismiss',
  isUndoable: true,
  prepare: prepareSnapshot,
  async execute(input, ctx) {
    const em = resolveEm(ctx)
    const lookalike = await loadForUpdate(em, input, ctx)
    if (lookalike.status === 'imported') throw new CrudHttpError(409, { error: 'record_not_applicable' })
    if (lookalike.status !== 'dismissed') {
      lookalike.status = 'dismissed'
      lookalike.dismissedAt = new Date()
      lookalike.dismissedByUserId = input.userId
      await em.flush()
    }
    return { lookalikeId: lookalike.id, status: lookalike.status }
  },
  buildLog({ input, result, snapshots }) {
    return {
      actionLabel: 'enrichment_treg.lookalikes.dismiss',
      resourceKind: LOOKALIKE_RESOURCE_KIND,
      resourceId: result.lookalikeId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      snapshotBefore: snapshots.before ?? null,
    }
  },
  async undo({ input, ctx, logEntry }) {
    await undoFromSnapshot(input, ctx, logEntry.snapshotBefore)
  },
}

registerCommand(markImportedCommand)
registerCommand(dismissCommand)

export { markImportedCommand, dismissCommand }
