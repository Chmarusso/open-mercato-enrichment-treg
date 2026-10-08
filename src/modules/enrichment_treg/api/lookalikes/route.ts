import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiMethodDoc, OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { EnrichmentLookalike, EnrichmentRecord } from '../../data/entities'
import { enrichmentLookalikeSchema, enrichmentRecordSchema, lookalikesQuerySchema } from '../../data/validators'
import { LOOKALIKE_ENDPOINT, LOOKALIKES_MATCH_SCAN_MAX } from '../../lib/constants'
import { serializeRecord } from '../../lib/enrichment-service'
import { applyCrmMatch, loadCrmDomainIndex, serializeLookalike } from '../../lib/lookalikes'
import { ensureSubjectAccess, errorSchema, hasFeatures, jsonError, resolveRequestScope } from '../helpers'

const logger = createLogger('enrichment_treg').child({ component: 'api/lookalikes' })

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['enrichment_treg.view'] },
}

export async function GET(req: Request) {
  const scope = await resolveRequestScope(req)
  if (scope instanceof NextResponse) return scope

  const url = new URL(req.url)
  const parsed = lookalikesQuerySchema.safeParse(Object.fromEntries(url.searchParams))
  if (!parsed.success) return jsonError(400, 'validation_failed')
  const { companyId, status, ids, page, pageSize } = parsed.data
  const accessDenied = await ensureSubjectAccess(scope, 'company')
  if (accessDenied) return accessDenied

  const em = scope.container.resolve<EntityManager>('em').fork()
  const tenantScope = { tenantId: scope.tenantId, organizationId: scope.organizationId }
  const where = {
    ...tenantScope,
    seedCompanyId: companyId,
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(ids ? { id: { $in: ids } } : {}),
  }
  const [lookalikes, total, latest, canImport] = await Promise.all([
    findWithDecryption(
      em,
      EnrichmentLookalike,
      where,
      { orderBy: { firstSeenAt: 'desc', id: 'asc' }, limit: pageSize, offset: (page - 1) * pageSize },
      tenantScope,
    ),
    em.count(EnrichmentLookalike, where),
    findOneWithDecryption(
      em,
      EnrichmentRecord,
      { ...tenantScope, subjectType: 'company', subjectId: companyId, endpointId: LOOKALIKE_ENDPOINT, deletedAt: null },
      { orderBy: { createdAt: 'desc' } },
      tenantScope,
    ),
    hasFeatures(scope, ['customers.companies.manage']),
  ])

  let crmMatchSkipped = false
  if (lookalikes.some((lookalike) => lookalike.status === 'new' || lookalike.status === 'in_crm')) {
    try {
      const index = await loadCrmDomainIndex(em, tenantScope, LOOKALIKES_MATCH_SCAN_MAX)
      if (index) {
        if (applyCrmMatch(lookalikes, index, companyId) > 0) await em.flush()
      } else {
        crmMatchSkipped = true
      }
    } catch (err) {
      logger.warn('Failed to re-match lookalikes against CRM companies', { err, companyId })
      crmMatchSkipped = true
    }
  }

  return NextResponse.json({
    items: lookalikes.map(serializeLookalike),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    latest: latest ? serializeRecord(latest) : null,
    canImport,
    crmMatchSkipped,
  })
}

const getDoc: OpenApiMethodDoc = {
  summary: 'List similar companies',
  description: 'Companies found as similar to a CRM company, newest first, with their CRM status. Rows still new or already in the CRM are re-matched against CRM company domains on every read. Also returns the latest lookup record and whether the caller may add companies to the CRM.',
  tags: ['treg Enrichment'],
  query: lookalikesQuerySchema,
  responses: [
    {
      status: 200,
      description: 'Similar companies',
      schema: z.object({
        items: z.array(enrichmentLookalikeSchema),
        total: z.number(),
        page: z.number(),
        pageSize: z.number(),
        totalPages: z.number(),
        latest: enrichmentRecordSchema.nullable(),
        canImport: z.boolean(),
        crmMatchSkipped: z.boolean(),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Invalid query', schema: errorSchema },
    { status: 401, description: 'Not authenticated', schema: errorSchema },
    { status: 403, description: 'Missing customers.companies.view', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'List companies similar to a CRM company',
  methods: { GET: getDoc },
}
