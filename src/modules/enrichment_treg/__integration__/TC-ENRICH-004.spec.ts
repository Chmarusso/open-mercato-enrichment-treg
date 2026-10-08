import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from './helpers/api'
import {
  configureTreg,
  createCompany,
  deleteSubject,
  isTregConfigured,
  listLookalikes,
  resetTreg,
  startTregStub,
  waitForLookalikeLookup,
  type TregStub,
} from './helpers/fixtures'

/**
 * TC-ENRICH-004: similar companies
 *
 * A lookup sends the seed domain to the leadsforge preview, stores the rows
 * without the seed or duplicates, and marks a row whose domain already exists
 * in the CRM as in_crm. A company created through the customers API can be
 * linked to its row, an added row cannot be dismissed, a dismissed row stays
 * dismissed after another lookup, and a company without a domain is rejected.
 */
test.describe('TC-ENRICH-004: similar companies', () => {
  test('finds, matches, adds and dismisses similar companies', async ({ request }) => {
    test.setTimeout(420_000)
    const token = await getAuthToken(request, 'admin')
    test.skip(await isTregConfigured(request, token), 'treg already configured on this tenant; not overwriting real credentials')

    const suffix = `${Date.now()}`
    const companyIds: string[] = []
    let stub: TregStub | null = null
    try {
      stub = await startTregStub()
      stub.respond('/call/leadsforge.companies.lookalike.preview', {
        status: 200,
        body: {
          companies: [
            { domain: `treg-${suffix}.example`, name: 'Seed itself' },
            { domain: `alpha-${suffix}.example`, name: `Alpha ${suffix}`, website: `https://alpha-${suffix}.example`, industry: 'Software', description: 'Alpha builds CRM tools.' },
            { domain: `beta-${suffix}.example`, name: `Beta ${suffix}`, industry: 'Software' },
            { domain: `gamma-${suffix}.example`, name: `Gamma ${suffix}` },
            { name: 'No domain' },
          ],
          totalCount: 4,
        },
        headers: { 'x-treg-cost-micro': '0' },
      })
      const seedId = await createCompany(request, token, suffix)
      companyIds.push(seedId)
      const existing = await apiRequest(request, 'POST', '/api/customers/companies', {
        token,
        data: { displayName: `Gamma existing ${suffix}`, websiteUrl: `https://www.gamma-${suffix}.example/about` },
      })
      expect(existing.status()).toBe(201)
      const existingId = String((await existing.json()).id)
      companyIds.push(existingId)
      const noDomain = await apiRequest(request, 'POST', '/api/customers/companies', { token, data: { displayName: `No domain ${suffix}` } })
      const noDomainId = String((await noDomain.json()).id)
      companyIds.push(noDomainId)
      await configureTreg(request, token, stub.baseUrl)

      const rejected = await apiRequest(request, 'POST', '/api/enrichment_treg/lookalikes/refresh', { token, data: { companyId: noDomainId } })
      expect(rejected.status()).toBe(422)
      expect((await rejected.json()).error).toBe('missing_identity')

      const started = await apiRequest(request, 'POST', '/api/enrichment_treg/lookalikes/refresh', { token, data: { companyId: seedId } })
      expect(started.status()).toBe(202)
      const first = await waitForLookalikeLookup(request, token, seedId)
      expect(first.latest?.status).toBe('completed')
      expect(first.canImport).toBe(true)
      const call = stub.calls.find((entry) => entry.url === '/call/leadsforge.companies.lookalike.preview')
      expect(JSON.parse(call?.body ?? '{}')).toEqual({ domains: [`treg-${suffix}.example`] })

      const byDomain = new Map(first.items.map((item) => [item.domain, item]))
      expect([...byDomain.keys()].sort()).toEqual([`alpha-${suffix}.example`, `beta-${suffix}.example`, `gamma-${suffix}.example`])
      expect(byDomain.get(`gamma-${suffix}.example`)).toMatchObject({ status: 'in_crm', crmCompanyId: existingId })
      const alpha = byDomain.get(`alpha-${suffix}.example`)!
      const beta = byDomain.get(`beta-${suffix}.example`)!
      expect(alpha.status).toBe('new')

      const created = await apiRequest(request, 'POST', '/api/customers/companies', {
        token,
        data: { displayName: alpha.name, brandName: alpha.name, domain: alpha.domain },
      })
      expect(created.status()).toBe(201)
      const createdId = String((await created.json()).id)
      companyIds.push(createdId)
      const marked = await apiRequest(request, 'POST', `/api/enrichment_treg/lookalikes/${alpha.id}/imported`, { token, data: { companyId: createdId } })
      expect(marked.status()).toBe(200)
      expect((await marked.json()).lookalike).toMatchObject({ status: 'imported', crmCompanyId: createdId })

      const again = await apiRequest(request, 'POST', `/api/enrichment_treg/lookalikes/${alpha.id}/imported`, { token, data: { companyId: createdId } })
      expect(again.status()).toBe(409)
      const dismissImported = await apiRequest(request, 'POST', `/api/enrichment_treg/lookalikes/${alpha.id}/dismiss`, { token })
      expect(dismissImported.status()).toBe(409)
      const foreignCompany = await apiRequest(request, 'POST', `/api/enrichment_treg/lookalikes/${beta.id}/imported`, {
        token,
        data: { companyId: '00000000-0000-4000-8000-000000000000' },
      })
      expect(foreignCompany.status()).toBe(404)

      const dismissed = await apiRequest(request, 'POST', `/api/enrichment_treg/lookalikes/${beta.id}/dismiss`, { token })
      expect(dismissed.status()).toBe(200)

      expect((await apiRequest(request, 'POST', '/api/enrichment_treg/lookalikes/refresh', { token, data: { companyId: seedId } })).status()).toBe(202)
      const second = await waitForLookalikeLookup(request, token, seedId, first.latest?.id ?? null)
      expect(second.total).toBe(3)
      const statuses = Object.fromEntries(second.items.map((item) => [item.domain, item.status]))
      expect(statuses).toEqual({
        [`alpha-${suffix}.example`]: 'imported',
        [`beta-${suffix}.example`]: 'dismissed',
        [`gamma-${suffix}.example`]: 'in_crm',
      })

      await deleteSubject(request, token, 'company', existingId)
      const afterDelete = await listLookalikes(request, token, seedId)
      expect(afterDelete.items.find((item) => item.domain === `gamma-${suffix}.example`)).toMatchObject({ status: 'new', crmCompanyId: null })
    } finally {
      for (const id of companyIds) await deleteSubject(request, token, 'company', id)
      await resetTreg(request, token)
      await stub?.close()
    }
  })
})
