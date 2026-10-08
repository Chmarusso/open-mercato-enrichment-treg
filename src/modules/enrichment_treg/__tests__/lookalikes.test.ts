import type { EnrichmentLookalike } from '../data/entities'
import {
  applyCrmMatch,
  buildCrmDomainIndex,
  buildLookalikeRequestBody,
  computeLookalikeDedupeHash,
  normalizeLookalikes,
  readSeedDomain,
} from '../lib/lookalikes'
import preview from './fixtures/leadsforge-lookalike-preview.json'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({ findWithDecryption: jest.fn() }))
jest.mock('@open-mercato/core/modules/customers/data/entities', () => ({ CustomerCompanyProfile: class CustomerCompanyProfile {} }))

function makeLookalike(overrides: Partial<EnrichmentLookalike> = {}): EnrichmentLookalike {
  return { id: 'l-1', domain: 'attio.com', status: 'new', crmCompanyId: null, ...overrides } as EnrichmentLookalike
}

describe('normalizeLookalikes', () => {
  it('maps leadsforge preview rows', () => {
    const result = normalizeLookalikes({ output: preview, seedDomain: 'pipedrive.com' })

    expect(result.skippedRows).toBe(0)
    expect(result.lookalikes.map((row) => row.domain)).toEqual(['attio.com', 'insightly.com', 'capsulecrm.com', 'close.com'])
    expect(result.lookalikes[0]).toMatchObject({
      name: 'Attio',
      domain: 'attio.com',
      websiteUrl: 'https://attio.com',
      industry: 'Software',
      description: 'Attio provides a customer relationship management platform for revenue teams.',
      dedupeHash: computeLookalikeDedupeHash('attio.com'),
    })
    expect(result.lookalikes[0].payload).toEqual(preview.companies[0])
  })

  it('drops the seed domain and duplicates, and counts rows without a name or domain', () => {
    const result = normalizeLookalikes({
      output: {
        companies: [
          { domain: 'www.Pipedrive.com', name: 'Pipedrive' },
          { domain: 'attio.com', name: 'Attio' },
          { website: 'https://attio.com/pricing', name: 'Attio again' },
          { domain: 'no-name.example' },
          { name: 'No domain' },
          'not a row',
        ],
      },
      seedDomain: 'pipedrive.com',
    })

    expect(result.lookalikes.map((row) => row.name)).toEqual(['Attio'])
    expect(result.skippedRows).toBe(3)
  })

  it('falls back to generic row fields and builds a website from the domain', () => {
    const result = normalizeLookalikes({
      output: { companies: [{ website_url: 'chronometriq.com', company_name: 'ChronoMetriq', industries: ['Telecommunications'] }] },
      seedDomain: null,
    })

    expect(result.lookalikes[0]).toMatchObject({
      name: 'ChronoMetriq',
      domain: 'chronometriq.com',
      websiteUrl: 'https://chronometriq.com',
      industry: 'Telecommunications',
      description: null,
    })
  })

  it('keeps at most the limit of rows', () => {
    const result = normalizeLookalikes({ output: preview, seedDomain: null, limit: 2 })
    expect(result.lookalikes).toHaveLength(2)
  })

  it('returns nothing for a missing list', () => {
    expect(normalizeLookalikes({ output: {}, seedDomain: null })).toEqual({ lookalikes: [], skippedRows: 0 })
  })
})

describe('lookalike request identity', () => {
  it('sends the normalized domain, falling back to the website host', () => {
    expect(buildLookalikeRequestBody({ domain: 'WWW.Acme.com' })).toEqual({ domains: ['acme.com'] })
    expect(buildLookalikeRequestBody({ website: 'https://www.acme.io/about' })).toEqual({ domains: ['acme.io'] })
    expect(buildLookalikeRequestBody({ name: 'Acme' })).toBeNull()
  })

  it('reads the seed domain back from the stored identity', () => {
    expect(readSeedDomain({ domains: ['acme.com'] })).toBe('acme.com')
    expect(readSeedDomain({ domain: 'acme.com' })).toBeNull()
    expect(readSeedDomain(null)).toBeNull()
  })
})

describe('CRM matching', () => {
  it('indexes domains and website hosts, first company wins', () => {
    const index = buildCrmDomainIndex([
      { companyId: 'c-1', domain: 'Attio.com', websiteUrl: null },
      { companyId: 'c-2', domain: null, websiteUrl: 'https://www.close.com/' },
      { companyId: 'c-3', domain: 'attio.com', websiteUrl: 'not a url' },
    ])
    expect(Object.fromEntries(index)).toEqual({ 'attio.com': 'c-1', 'close.com': 'c-2' })
  })

  it('marks matches as in_crm, releases rows whose company is gone and ignores the seed', () => {
    const index = new Map([
      ['attio.com', 'c-1'],
      ['seed.com', 'seed-1'],
    ])
    const matched = makeLookalike()
    const released = makeLookalike({ id: 'l-2', domain: 'close.com', status: 'in_crm', crmCompanyId: 'c-9' })
    const seed = makeLookalike({ id: 'l-3', domain: 'seed.com' })
    const dismissed = makeLookalike({ id: 'l-4', status: 'dismissed' })
    const imported = makeLookalike({ id: 'l-5', status: 'imported', crmCompanyId: 'c-5' })

    const changed = applyCrmMatch([matched, released, seed, dismissed, imported], index, 'seed-1')

    expect(changed).toBe(2)
    expect(matched).toMatchObject({ status: 'in_crm', crmCompanyId: 'c-1' })
    expect(released).toMatchObject({ status: 'new', crmCompanyId: null })
    expect(seed).toMatchObject({ status: 'new', crmCompanyId: null })
    expect(dismissed).toMatchObject({ status: 'dismissed', crmCompanyId: null })
    expect(imported).toMatchObject({ status: 'imported', crmCompanyId: 'c-5' })
  })
})
