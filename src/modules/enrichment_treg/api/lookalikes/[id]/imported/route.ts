import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiMethodDoc, OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { LOOKALIKE_RESOURCE_KIND, type MarkLookalikeImportedInput } from '../../../../commands/lookalikes'
import { EnrichmentLookalike } from '../../../../data/entities'
import { enrichmentLookalikeSchema, markLookalikeImportedSchema } from '../../../../data/validators'
import { serializeLookalike } from '../../../../lib/lookalikes'
import { companyExists } from '../../../../lib/subject'
import {
  commandErrorResponse,
  ensureSubjectAccess,
  errorSchema,
  jsonError,
  rejectInvalidWriteScope,
  resolveCommandBus,
  resolveRequestScope,
  runGuardAfterSuccess,
  runWriteGuards,
} from '../../../helpers'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['enrichment_treg.run'] },
}

export async function POST(
  req: Request,
  context: { params: { id: string } | Promise<{ id: string }> },
) {
  const scope = await resolveRequestScope(req)
  if (scope instanceof NextResponse) return scope
  const scopeRejection = rejectInvalidWriteScope(scope)
  if (scopeRejection) return scopeRejection

  const { id } = await Promise.resolve(context.params)
  if (!z.string().uuid().safeParse(id).success) return jsonError(400, 'validation_failed')
  const parsed = markLookalikeImportedSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return jsonError(400, 'validation_failed')
  const accessDenied = await ensureSubjectAccess(scope, 'company')
  if (accessDenied) return accessDenied

  const em = scope.container.resolve<EntityManager>('em').fork()
  const tenantScope = { tenantId: scope.tenantId, organizationId: scope.organizationId }
  if (!(await companyExists(em, parsed.data.companyId, tenantScope))) return jsonError(404, 'subject_not_found')

  const guard = await runWriteGuards({
    scope,
    req,
    resourceId: id,
    operation: 'update',
    payload: parsed.data,
    resourceKind: LOOKALIKE_RESOURCE_KIND,
  })
  if (!guard.ok) return guard.response

  try {
    await resolveCommandBus(scope).execute<MarkLookalikeImportedInput, { lookalikeId: string }>(
      'enrichment_treg.lookalikes.mark_imported',
      {
        input: { ...tenantScope, lookalikeId: id, companyId: parsed.data.companyId, userId: scope.userId },
        ctx: scope.commandContext,
        metadata: { ...tenantScope, resourceKind: LOOKALIKE_RESOURCE_KIND, resourceId: id },
      },
    )
  } catch (error) {
    const response = commandErrorResponse(error)
    if (response) return response
    throw error
  }

  const lookalike = await findOneWithDecryption(em.fork(), EnrichmentLookalike, { id, ...tenantScope }, undefined, tenantScope)
  if (!lookalike) return jsonError(404, 'lookalike_not_found')
  await runGuardAfterSuccess(guard.callbacks, { scope, req, resourceId: id, operation: 'update', resourceKind: LOOKALIKE_RESOURCE_KIND })
  return NextResponse.json({ lookalike: serializeLookalike(lookalike) })
}

const postDoc: OpenApiMethodDoc = {
  summary: 'Mark a similar company as added to the CRM',
  description: 'Links a similar-company row to the CRM company created from it through the customers API. Undoable. Send the row updatedAt as the optimistic-lock header.',
  tags: ['treg Enrichment'],
  requestBody: { contentType: 'application/json', schema: markLookalikeImportedSchema },
  responses: [{ status: 200, description: 'Row updated', schema: z.object({ lookalike: enrichmentLookalikeSchema }) }],
  errors: [
    { status: 400, description: 'Invalid payload', schema: errorSchema },
    { status: 401, description: 'Not authenticated', schema: errorSchema },
    { status: 403, description: 'Missing customers.companies.view, or the selected organization is not allowed', schema: errorSchema },
    { status: 404, description: 'Row or company not found in scope', schema: errorSchema },
    { status: 409, description: 'Row is not new, or it changed since it was read', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Mark a treg similar company as added to the CRM',
  methods: { POST: postDoc },
}
