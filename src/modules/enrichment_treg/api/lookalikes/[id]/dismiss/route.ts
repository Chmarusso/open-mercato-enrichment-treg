import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiMethodDoc, OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { LOOKALIKE_RESOURCE_KIND, type DismissLookalikeInput } from '../../../../commands/lookalikes'
import { EnrichmentLookalike } from '../../../../data/entities'
import { enrichmentLookalikeSchema } from '../../../../data/validators'
import { serializeLookalike } from '../../../../lib/lookalikes'
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
  const accessDenied = await ensureSubjectAccess(scope, 'company')
  if (accessDenied) return accessDenied

  const tenantScope = { tenantId: scope.tenantId, organizationId: scope.organizationId }
  const guard = await runWriteGuards({
    scope,
    req,
    resourceId: id,
    operation: 'update',
    payload: { id },
    resourceKind: LOOKALIKE_RESOURCE_KIND,
  })
  if (!guard.ok) return guard.response

  try {
    await resolveCommandBus(scope).execute<DismissLookalikeInput, { lookalikeId: string }>(
      'enrichment_treg.lookalikes.dismiss',
      {
        input: { ...tenantScope, lookalikeId: id, userId: scope.userId },
        ctx: scope.commandContext,
        metadata: { ...tenantScope, resourceKind: LOOKALIKE_RESOURCE_KIND, resourceId: id },
      },
    )
  } catch (error) {
    const response = commandErrorResponse(error)
    if (response) return response
    throw error
  }

  const em = scope.container.resolve<EntityManager>('em').fork()
  const lookalike = await findOneWithDecryption(em, EnrichmentLookalike, { id, ...tenantScope }, undefined, tenantScope)
  if (!lookalike) return jsonError(404, 'lookalike_not_found')
  await runGuardAfterSuccess(guard.callbacks, { scope, req, resourceId: id, operation: 'update', resourceKind: LOOKALIKE_RESOURCE_KIND })
  return NextResponse.json({ lookalike: serializeLookalike(lookalike) })
}

const postDoc: OpenApiMethodDoc = {
  summary: 'Dismiss a similar company',
  description: 'Hides a similar-company row that is not relevant. It stays dismissed when a later lookup finds it again. Undoable. Send the row updatedAt as the optimistic-lock header.',
  tags: ['treg Enrichment'],
  responses: [{ status: 200, description: 'Row updated', schema: z.object({ lookalike: enrichmentLookalikeSchema }) }],
  errors: [
    { status: 400, description: 'Invalid id', schema: errorSchema },
    { status: 401, description: 'Not authenticated', schema: errorSchema },
    { status: 403, description: 'Missing customers.companies.view, or the selected organization is not allowed', schema: errorSchema },
    { status: 404, description: 'Row not found in scope', schema: errorSchema },
    { status: 409, description: 'Row was already added to the CRM, or it changed since it was read', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Dismiss a treg similar company',
  methods: { POST: postDoc },
}
