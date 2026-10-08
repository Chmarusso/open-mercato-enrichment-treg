import { createHash } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerCompanyProfile } from '@open-mercato/core/modules/customers/data/entities'
import type { EnrichmentLookalike } from '../data/entities'
import { LOOKALIKE_LIST_KEY, LOOKALIKES_DEFAULT_LIMIT, type LookalikeStatus } from './constants'
import { normalizeDomain, normalizeUrl, type CompanyIdentity } from './normalize'

export type NormalizedLookalike = {
  name: string
  domain: string
  websiteUrl: string | null
  industry: string | null
  description: string | null
  dedupeHash: string
  payload: Record<string, unknown>
}

export type LookalikeNormalization = {
  lookalikes: NormalizedLookalike[]
  skippedRows: number
}

type Scope = { tenantId: string; organizationId: string }

const NAME_MAX_LENGTH = 200
const INDUSTRY_MAX_LENGTH = 150
const DESCRIPTION_MAX_LENGTH = 4000
const URL_MAX_LENGTH = 500
const MATCH_BATCH_SIZE = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null
}

function firstText(source: Record<string, unknown>, keys: string[], maxLength: number): string | null {
  for (const key of keys) {
    const value = source[key]
    const candidate = Array.isArray(value) ? value[0] : value
    const result = text(candidate, maxLength)
    if (result) return result
  }
  return null
}

function firstDomain(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const domain = normalizeDomain(source[key])
    if (domain) return domain
  }
  return null
}

export function computeLookalikeDedupeHash(domain: string): string {
  return createHash('sha256').update(`lookalike|${domain}`).digest('hex')
}

export function normalizeLookalikes(params: {
  output: Record<string, unknown>
  seedDomain: string | null
  limit?: number
}): LookalikeNormalization {
  const rows = params.output[LOOKALIKE_LIST_KEY]
  const list = Array.isArray(rows) ? rows : []
  const limit = params.limit ?? LOOKALIKES_DEFAULT_LIMIT
  const seen = new Set<string>(params.seedDomain ? [params.seedDomain] : [])
  const lookalikes: NormalizedLookalike[] = []
  let skippedRows = 0

  for (const row of list) {
    if (lookalikes.length >= limit) break
    if (!isRecord(row)) {
      skippedRows += 1
      continue
    }
    const domain = firstDomain(row, ['domain', 'website', 'website_url', 'url'])
    const name = firstText(row, ['name', 'company_name', 'title'], NAME_MAX_LENGTH)
    if (!domain || !name) {
      skippedRows += 1
      continue
    }
    if (seen.has(domain)) continue
    seen.add(domain)
    const websiteUrl = normalizeUrl(row.website ?? row.website_url ?? domain)
    lookalikes.push({
      name,
      domain,
      websiteUrl: websiteUrl && websiteUrl.length <= URL_MAX_LENGTH ? websiteUrl : null,
      industry: firstText(row, ['industry', 'industries'], INDUSTRY_MAX_LENGTH),
      description: firstText(row, ['description', 'summary'], DESCRIPTION_MAX_LENGTH),
      dedupeHash: computeLookalikeDedupeHash(domain),
      payload: row,
    })
  }

  return { lookalikes, skippedRows }
}

export function buildLookalikeRequestBody(identity: CompanyIdentity): Record<string, unknown> | null {
  const domain = normalizeDomain(identity.domain) ?? normalizeDomain(identity.website)
  return domain ? { domains: [domain] } : null
}

export function readSeedDomain(identity: Record<string, unknown> | null | undefined): string | null {
  const domains = identity?.domains
  return Array.isArray(domains) ? normalizeDomain(domains[0]) : null
}

export function buildCrmDomainIndex(
  profiles: Array<{ companyId: string; domain?: string | null; websiteUrl?: string | null }>,
): Map<string, string> {
  const index = new Map<string, string>()
  for (const profile of profiles) {
    for (const value of [profile.domain, profile.websiteUrl]) {
      const domain = normalizeDomain(value)
      if (domain && !index.has(domain)) index.set(domain, profile.companyId)
    }
  }
  return index
}

export async function loadCrmDomainIndex(
  em: EntityManager,
  scope: Scope,
  scanMax: number,
): Promise<Map<string, string> | null> {
  const where = {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    entity: { deletedAt: null, kind: 'company' as const },
  }
  const total = await em.count(CustomerCompanyProfile, where)
  if (total > scanMax) return null
  const profiles: Array<{ companyId: string; domain?: string | null; websiteUrl?: string | null }> = []
  for (let offset = 0; offset < total; offset += MATCH_BATCH_SIZE) {
    const batch = await findWithDecryption(
      em,
      CustomerCompanyProfile,
      where,
      { orderBy: { id: 'asc' }, limit: MATCH_BATCH_SIZE, offset },
      scope,
    )
    for (const profile of batch) {
      profiles.push({ companyId: profile.entity.id, domain: profile.domain, websiteUrl: profile.websiteUrl })
    }
  }
  return buildCrmDomainIndex(profiles)
}

export function applyCrmMatch(
  lookalikes: EnrichmentLookalike[],
  index: Map<string, string>,
  seedCompanyId: string,
): number {
  let changed = 0
  for (const lookalike of lookalikes) {
    if (lookalike.status !== 'new' && lookalike.status !== 'in_crm') continue
    const matchId = index.get(lookalike.domain) ?? null
    const companyId = matchId === seedCompanyId ? null : matchId
    const status: LookalikeStatus = companyId ? 'in_crm' : 'new'
    if (lookalike.status === status && (lookalike.crmCompanyId ?? null) === companyId) continue
    lookalike.status = status
    lookalike.crmCompanyId = companyId
    changed += 1
  }
  return changed
}

export type SerializedLookalike = {
  id: string
  seedCompanyId: string
  name: string
  domain: string
  websiteUrl: string | null
  industry: string | null
  description: string | null
  source: string | null
  status: LookalikeStatus
  crmCompanyId: string | null
  importedAt: string | null
  dismissedAt: string | null
  firstSeenAt: string
  lastSeenAt: string
  updatedAt: string
}

export function serializeLookalike(lookalike: EnrichmentLookalike): SerializedLookalike {
  return {
    id: lookalike.id,
    seedCompanyId: lookalike.seedCompanyId,
    name: lookalike.name,
    domain: lookalike.domain,
    websiteUrl: lookalike.websiteUrl ?? null,
    industry: lookalike.industry ?? null,
    description: lookalike.description ?? null,
    source: lookalike.source ?? null,
    status: lookalike.status,
    crmCompanyId: lookalike.crmCompanyId ?? null,
    importedAt: lookalike.importedAt ? lookalike.importedAt.toISOString() : null,
    dismissedAt: lookalike.dismissedAt ? lookalike.dismissedAt.toISOString() : null,
    firstSeenAt: lookalike.firstSeenAt.toISOString(),
    lastSeenAt: lookalike.lastSeenAt.toISOString(),
    updatedAt: lookalike.updatedAt.toISOString(),
  }
}
