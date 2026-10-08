"use client"

import * as React from 'react'
import { Building2, ExternalLink, EyeOff, Plus, Search } from 'lucide-react'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { formatDateTime, formatRelativeTime } from '@open-mercato/shared/lib/time'
import type { AppEventPayload } from '@open-mercato/shared/modules/widgets/injection'
import { apiCall, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useAppEvent } from '@open-mercato/ui/backend/injection/useAppEvent'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { LoadingMessage } from '@open-mercato/ui/backend/detail'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { Checkbox } from '@open-mercato/ui/primitives/checkbox'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'

type LookalikeStatus = 'new' | 'in_crm' | 'imported' | 'dismissed'

type Lookalike = {
  id: string
  name: string
  domain: string
  websiteUrl: string | null
  industry: string | null
  description: string | null
  status: LookalikeStatus
  crmCompanyId: string | null
  updatedAt: string
}

type LookupRecord = {
  id: string
  status: 'pending' | 'running' | 'completed' | 'no_match' | 'failed'
  failureReason: string | null
  summary: Record<string, unknown> | null
  fetchedAt: string | null
  createdAt: string
}

type LookalikesResponse = {
  items: Lookalike[]
  total: number
  latest: LookupRecord | null
  canImport: boolean
  crmMatchSkipped: boolean
}

type SimilarCompaniesSectionProps = {
  companyId: string
  context: Record<string, unknown>
}

type ImportOutcome = { added: number; skipped: number; failed: number }

const POLL_INTERVAL_MS = 2000
const POLL_MAX_ATTEMPTS = 45
const PAGE_SIZE = 100

const STATUS_VARIANT: Record<LookalikeStatus, StatusBadgeVariant> = {
  new: 'info',
  in_crm: 'neutral',
  imported: 'success',
  dismissed: 'neutral',
}

function companyHref(companyId: string): string {
  return `/backend/customers/companies-v2/${encodeURIComponent(companyId)}`
}

function isInFlight(record: LookupRecord | null | undefined): boolean {
  return record?.status === 'pending' || record?.status === 'running'
}

function errorStatus(err: unknown): number | null {
  return err && typeof err === 'object' && typeof (err as { status?: unknown }).status === 'number'
    ? (err as { status: number }).status
    : null
}

export default function SimilarCompaniesSection({ companyId, context }: SimilarCompaniesSectionProps) {
  const t = useT()
  const locale = useLocale()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [data, setData] = React.useState<LookalikesResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [starting, setStarting] = React.useState(false)
  const [importing, setImporting] = React.useState(false)
  const [stalled, setStalled] = React.useState(false)
  const [showDismissed, setShowDismissed] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const pollAttempts = React.useRef(0)

  const { runMutation } = useGuardedMutation<Record<string, unknown>>({
    contextId: `enrichment_treg:lookalikes:${companyId}`,
  })

  const load = React.useCallback(async () => {
    setLoadError(null)
    try {
      const params = new URLSearchParams({ companyId, pageSize: String(PAGE_SIZE) })
      const payload = await readApiResultOrThrow<LookalikesResponse>(
        `/api/enrichment_treg/lookalikes?${params.toString()}`,
        undefined,
        { errorMessage: t('enrichment_treg.lookalikes.errors.load', 'Failed to load similar companies.') },
      )
      setData(payload)
      setSelected((previous) => {
        const selectable = new Set(payload.items.filter((item) => item.status === 'new').map((item) => item.id))
        return new Set([...previous].filter((id) => selectable.has(id)))
      })
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('enrichment_treg.lookalikes.errors.load', 'Failed to load similar companies.'))
    } finally {
      setLoading(false)
    }
  }, [companyId, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const reloadOnEvent = React.useCallback(
    (event: AppEventPayload) => {
      if (event.payload?.subjectId === companyId) void load()
    },
    [companyId, load],
  )
  useAppEvent('enrichment_treg.record.*', reloadOnEvent, [reloadOnEvent])

  const inFlight = isInFlight(data?.latest)
  React.useEffect(() => {
    if (!inFlight) {
      pollAttempts.current = 0
      setStalled(false)
      return
    }
    if (pollAttempts.current >= POLL_MAX_ATTEMPTS) {
      setStalled(true)
      return
    }
    const timer = setTimeout(() => {
      pollAttempts.current += 1
      void load()
    }, POLL_INTERVAL_MS)
    return () => clearTimeout(timer)
  }, [data, inFlight, load])

  const refreshNow = React.useCallback(() => {
    pollAttempts.current = 0
    setStalled(false)
    void load()
  }, [load])

  const startLookup = React.useCallback(async () => {
    setStarting(true)
    try {
      const call = await runMutation({
        operation: () =>
          apiCall<{ record?: LookupRecord; error?: string }>('/api/enrichment_treg/lookalikes/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ companyId }),
          }),
        mutationPayload: { companyId },
        context,
      })
      if (call.ok && call.result?.record) {
        pollAttempts.current = 0
        setStalled(false)
        await load()
        return
      }
      const code = call.result?.error ?? 'unexpected'
      const fallback = t('enrichment_treg.lookalikes.errors.unexpected', 'The search could not be started.')
      flash(t(`enrichment_treg.lookalikes.errors.${code}`, t(`enrichment_treg.tab.errors.${code}`, fallback)), 'error')
    } catch {
      flash(t('enrichment_treg.lookalikes.errors.unexpected', 'The search could not be started.'), 'error')
    } finally {
      setStarting(false)
    }
  }, [companyId, context, load, runMutation, t])

  const dismiss = React.useCallback(
    async (item: Lookalike) => {
      try {
        await runMutation({
          operation: () =>
            withScopedApiRequestHeaders(buildOptimisticLockHeader(item.updatedAt), () =>
              readApiResultOrThrow(
                `/api/enrichment_treg/lookalikes/${encodeURIComponent(item.id)}/dismiss`,
                { method: 'POST' },
                { errorMessage: t('enrichment_treg.lookalikes.errors.dismiss', 'Could not dismiss this company.') },
              ),
            ),
          mutationPayload: { id: item.id },
          context,
        })
      } catch (err) {
        if (!surfaceRecordConflict(err, t, { onRefresh: () => void load() })) {
          flash(err instanceof Error ? err.message : t('enrichment_treg.lookalikes.errors.dismiss', 'Could not dismiss this company.'), 'error')
        }
      }
      await load()
    },
    [context, load, runMutation, t],
  )

  const importOne = React.useCallback(async (item: Lookalike): Promise<'added' | 'failed'> => {
    try {
      const created = await readApiResultOrThrow<{ id?: string | null }>(
        '/api/customers/companies',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            displayName: item.name,
            brandName: item.name,
            domain: item.domain,
            ...(item.websiteUrl ? { websiteUrl: item.websiteUrl } : {}),
            ...(item.industry ? { industry: item.industry } : {}),
            ...(item.description ? { description: item.description } : {}),
          }),
        },
        { errorMessage: t('enrichment_treg.lookalikes.errors.import', 'Could not add {name} to the CRM.', { name: item.name }) },
      )
      if (!created.id) return 'failed'
      await withScopedApiRequestHeaders(buildOptimisticLockHeader(item.updatedAt), () =>
        readApiResultOrThrow(
          `/api/enrichment_treg/lookalikes/${encodeURIComponent(item.id)}/imported`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ companyId: created.id }),
          },
        ),
      )
      return 'added'
    } catch {
      return 'failed'
    }
  }, [t])

  const importSelected = React.useCallback(async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    const names = (data?.items ?? []).filter((item) => selected.has(item.id)).map((item) => item.name)
    const proceed = await confirm({
      title: t('enrichment_treg.lookalikes.confirm.title', 'Add {count} companies to the CRM?', { count: ids.length }),
      description: t(
        'enrichment_treg.lookalikes.confirm.description',
        'Creates a CRM company for each one with its name, domain, website, industry and description: {names}',
        { names: names.join(', ') },
      ),
      confirmText: t('enrichment_treg.lookalikes.confirm.action', 'Add to CRM'),
    })
    if (!proceed) return
    setImporting(true)
    const outcome: ImportOutcome = { added: 0, skipped: 0, failed: 0 }
    try {
      await runMutation({
        operation: async () => {
          const params = new URLSearchParams({ companyId, ids: ids.join(','), pageSize: String(PAGE_SIZE) })
          const fresh = await readApiResultOrThrow<LookalikesResponse>(`/api/enrichment_treg/lookalikes?${params.toString()}`)
          for (const item of fresh.items) {
            if (item.status !== 'new') {
              outcome.skipped += 1
              continue
            }
            outcome[(await importOne(item)) === 'added' ? 'added' : 'failed'] += 1
          }
        },
        mutationPayload: { companyId, ids },
        context,
      })
    } catch (err) {
      flash(err instanceof Error ? err.message : t('enrichment_treg.lookalikes.errors.importBatch', 'Adding companies failed. Try again.'), 'error')
    }
    if (outcome.added > 0) {
      flash(t('enrichment_treg.lookalikes.imported', 'Added {count} companies to the CRM.', { count: outcome.added }), 'success')
    }
    if (outcome.skipped > 0) {
      flash(t('enrichment_treg.lookalikes.importSkipped', '{count} were already in the CRM and were skipped.', { count: outcome.skipped }), 'info')
    }
    if (outcome.failed > 0) {
      flash(t('enrichment_treg.lookalikes.importFailed', '{count} could not be added. Try them again.', { count: outcome.failed }), 'error')
    }
    setSelected(new Set())
    setImporting(false)
    await load()
  }, [companyId, confirm, context, data, importOne, load, runMutation, selected, t])

  const toggleSelected = React.useCallback((id: string, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const items = React.useMemo(
    () => (data?.items ?? []).filter((item) => showDismissed || item.status !== 'dismissed'),
    [data, showDismissed],
  )
  const dismissedCount = (data?.items ?? []).filter((item) => item.status === 'dismissed').length
  const canImport = data?.canImport === true
  const latest = data?.latest ?? null
  const busy = starting || (inFlight && !stalled)
  const lookupAt = latest?.fetchedAt ?? null

  return (
    <section className="space-y-4 border-t border-border pt-4" aria-labelledby={`treg-lookalikes-${companyId}`}>
      {ConfirmDialogElement}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 id={`treg-lookalikes-${companyId}`} className="flex items-center gap-2 text-sm font-semibold">
            <Building2 className="size-4" aria-hidden />
            {t('enrichment_treg.lookalikes.title', 'Similar companies')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t('enrichment_treg.lookalikes.description', 'Companies that look like this one, found by treg.to from its domain. Free to run.')}
          </p>
        </div>
        <Button type="button" variant="outline" onClick={startLookup} disabled={busy || importing}>
          <Search className="size-4" aria-hidden />
          {busy
            ? t('enrichment_treg.lookalikes.searching', 'Searching…')
            : latest
              ? t('enrichment_treg.lookalikes.searchAgain', 'Search again')
              : t('enrichment_treg.lookalikes.search', 'Find similar companies')}
        </Button>
      </div>

      {latest && !isInFlight(latest) && lookupAt ? (
        <p className="text-xs text-muted-foreground" title={formatDateTime(lookupAt) ?? undefined}>
          {latest.status === 'no_match'
            ? t('enrichment_treg.lookalikes.nothingFound', 'Nothing found {when}', { when: formatRelativeTime(lookupAt, { locale }) ?? '' })
            : t('enrichment_treg.lookalikes.searchedAt', 'Last searched {when}', { when: formatRelativeTime(lookupAt, { locale }) ?? '' })}
        </p>
      ) : null}

      {latest?.status === 'failed' ? (
        <Alert status="error" style="light" size="sm">
          {t(
            `enrichment_treg.tab.failure.${latest.failureReason ?? 'unexpected'}`,
            t('enrichment_treg.tab.failure.unexpected', 'The lookup failed. Try again later.'),
          )}
        </Alert>
      ) : null}

      {data?.crmMatchSkipped ? (
        <Alert status="warning" style="light" size="sm">
          {t('enrichment_treg.lookalikes.matchSkipped', 'Could not check which of these are already in the CRM. Check before adding them.')}
        </Alert>
      ) : null}

      {stalled ? (
        <Alert
          status="warning"
          style="light"
          size="sm"
          action={
            <Button type="button" variant="outline" size="sm" onClick={refreshNow}>
              {t('enrichment_treg.tab.refresh', 'Refresh')}
            </Button>
          }
        >
          {t('enrichment_treg.tab.stalled', 'The lookup is taking longer than expected. Refresh to check again.')}
        </Alert>
      ) : null}

      {loadError ? (
        <Alert
          status="error"
          style="light"
          size="sm"
          action={
            <Button type="button" variant="outline" size="sm" onClick={refreshNow}>
              {t('enrichment_treg.tab.retry', 'Retry')}
            </Button>
          }
        >
          {loadError}
        </Alert>
      ) : null}

      {loading ? (
        <LoadingMessage label={t('enrichment_treg.lookalikes.loading', 'Loading similar companies…')} />
      ) : (data?.items.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('enrichment_treg.lookalikes.empty', 'No similar companies yet. Search to find companies like this one.')}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {dismissedCount > 0 ? (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={showDismissed} onCheckedChange={(checked) => setShowDismissed(checked === true)} />
                {t('enrichment_treg.lookalikes.showDismissed', 'Show dismissed ({count})', { count: dismissedCount })}
              </label>
            ) : (
              <span />
            )}
            {canImport ? (
              <Button type="button" onClick={importSelected} disabled={importing || selected.size === 0}>
                <Plus className="size-4" aria-hidden />
                {importing
                  ? t('enrichment_treg.lookalikes.importing', 'Adding…')
                  : t('enrichment_treg.lookalikes.import', 'Add to CRM ({count})', { count: selected.size })}
              </Button>
            ) : null}
          </div>
          <ul className="divide-y divide-border rounded-md border border-border">
            {items.map((item) => {
              const selectable = canImport && item.status === 'new'
              return (
                <li key={item.id} className="flex gap-3 p-3">
                  <div className="pt-0.5">
                    <Checkbox
                      checked={selected.has(item.id)}
                      disabled={!selectable || importing}
                      onCheckedChange={(checked) => toggleSelected(item.id, checked === true)}
                      aria-label={t('enrichment_treg.lookalikes.select', 'Select {name}', { name: item.name })}
                    />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-words text-sm font-medium">{item.name}</span>
                      <a
                        href={item.websiteUrl ?? `https://${item.domain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
                      >
                        {item.domain}
                        <ExternalLink className="size-3 shrink-0" aria-hidden />
                      </a>
                      <StatusBadge variant={STATUS_VARIANT[item.status]}>
                        {t(`enrichment_treg.lookalikes.status.${item.status}`, item.status)}
                      </StatusBadge>
                      {item.crmCompanyId && (item.status === 'in_crm' || item.status === 'imported') ? (
                        <a href={companyHref(item.crmCompanyId)} className="text-xs font-medium hover:underline">
                          {t('enrichment_treg.lookalikes.openInCrm', 'Open in CRM')}
                        </a>
                      ) : null}
                    </div>
                    {item.industry ? <p className="text-xs text-muted-foreground">{item.industry}</p> : null}
                    {item.description ? <p className="line-clamp-2 text-xs text-muted-foreground">{item.description}</p> : null}
                  </div>
                  {item.status === 'new' || item.status === 'in_crm' ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={importing}
                      onClick={() => void dismiss(item)}
                      aria-label={t('enrichment_treg.lookalikes.dismissLabel', 'Dismiss {name}', { name: item.name })}
                    >
                      <EyeOff className="size-4" aria-hidden />
                      {t('enrichment_treg.lookalikes.dismiss', 'Dismiss')}
                    </Button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}
