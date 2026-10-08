import type { CommandRuntimeContext, CommandUndoLogEntry } from '@open-mercato/shared/lib/commands'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import { dismissCommand, markImportedCommand } from '../commands/lookalikes'
import type { EnrichmentLookalike } from '../data/entities'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
}))
jest.mock('../data/entities', () => ({ EnrichmentLookalike: class EnrichmentLookalike {} }))
jest.mock('@open-mercato/shared/lib/commands', () => ({ registerCommand: jest.fn() }))

const scope = { tenantId: 't1', organizationId: 'o1' }
const updatedAt = new Date('2026-10-08T10:00:00.000Z')

function makeContext(headers: Record<string, string> = {}) {
  const em = { flush: jest.fn(async () => undefined) }
  const ctx = {
    container: { resolve: jest.fn(() => ({ fork: () => em })) },
    auth: null,
    organizationScope: null,
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
    request: new Request('http://localhost/api', { headers }),
  } as unknown as CommandRuntimeContext
  return { ctx, em }
}

function makeLookalike(overrides: Partial<EnrichmentLookalike> = {}): EnrichmentLookalike {
  return {
    id: 'l-1',
    ...scope,
    seedCompanyId: 'seed-1',
    status: 'new',
    crmCompanyId: null,
    importedAt: null,
    importedByUserId: null,
    dismissedAt: null,
    dismissedByUserId: null,
    updatedAt,
    ...overrides,
  } as EnrichmentLookalike
}

function logEntry(snapshotBefore: unknown): CommandUndoLogEntry {
  return { snapshotBefore } as unknown as CommandUndoLogEntry
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('enrichment_treg.lookalikes.mark_imported', () => {
  const input = { ...scope, lookalikeId: 'l-1', companyId: 'crm-1', userId: 'user-1' }

  it('links the new CRM company and restores the row on undo', async () => {
    const lookalike = makeLookalike()
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(lookalike)
    const { ctx, em } = makeContext()

    const snapshot = await markImportedCommand.prepare!(input, ctx)
    const result = await markImportedCommand.execute(input, ctx)

    expect(result).toEqual({ lookalikeId: 'l-1', status: 'imported' })
    expect(lookalike).toMatchObject({ status: 'imported', crmCompanyId: 'crm-1', importedByUserId: 'user-1' })
    expect(lookalike.importedAt).toBeInstanceOf(Date)
    expect(em.flush).toHaveBeenCalled()

    await markImportedCommand.undo!({ input, ctx, logEntry: logEntry(snapshot?.before) })
    expect(lookalike).toMatchObject({ status: 'new', crmCompanyId: null, importedAt: null, importedByUserId: null })
  })

  it('rejects rows that are not new', async () => {
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(makeLookalike({ status: 'in_crm', crmCompanyId: 'crm-9' }))
    await expect(markImportedCommand.execute(input, makeContext().ctx)).rejects.toMatchObject({ status: 409 })
  })

  it('returns 404 for a row outside the scope', async () => {
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(null)
    await expect(markImportedCommand.execute(input, makeContext().ctx)).rejects.toMatchObject({ status: 404 })
  })

  it('rejects a stale optimistic-lock header', async () => {
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(makeLookalike())
    const { ctx } = makeContext({ [OPTIMISTIC_LOCK_HEADER_NAME]: '2026-10-01T00:00:00.000Z' })
    await expect(markImportedCommand.execute(input, ctx)).rejects.toMatchObject({ status: 409 })
  })

  it('accepts a matching optimistic-lock header', async () => {
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(makeLookalike())
    const { ctx } = makeContext({ [OPTIMISTIC_LOCK_HEADER_NAME]: updatedAt.toISOString() })
    await expect(markImportedCommand.execute(input, ctx)).resolves.toMatchObject({ status: 'imported' })
  })
})

describe('enrichment_treg.lookalikes.dismiss', () => {
  const input = { ...scope, lookalikeId: 'l-1', userId: 'user-1' }

  it('dismisses an in_crm row and restores it on undo', async () => {
    const lookalike = makeLookalike({ status: 'in_crm', crmCompanyId: 'crm-9' })
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(lookalike)
    const { ctx } = makeContext()

    const snapshot = await dismissCommand.prepare!(input, ctx)
    await dismissCommand.execute(input, ctx)
    expect(lookalike).toMatchObject({ status: 'dismissed', dismissedByUserId: 'user-1' })

    await dismissCommand.undo!({ input, ctx, logEntry: logEntry(snapshot?.before) })
    expect(lookalike).toMatchObject({ status: 'in_crm', crmCompanyId: 'crm-9', dismissedAt: null })
  })

  it('refuses to dismiss a company that was added to the CRM', async () => {
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(makeLookalike({ status: 'imported', crmCompanyId: 'crm-1' }))
    await expect(dismissCommand.execute(input, makeContext().ctx)).rejects.toMatchObject({ status: 409 })
  })
})
