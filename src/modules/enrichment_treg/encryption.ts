import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: 'enrichment_treg:enrichment_record',
    fields: [
      { field: 'identity' },
      { field: 'proposal' },
      { field: 'summary' },
      { field: 'raw_payload' },
    ],
  },
  {
    entityId: 'enrichment_treg:enrichment_signal',
    fields: [
      { field: 'title' },
      { field: 'summary' },
      { field: 'payload' },
    ],
  },
  {
    entityId: 'enrichment_treg:enrichment_lookalike',
    fields: [
      { field: 'name' },
      { field: 'domain' },
      { field: 'website_url' },
      { field: 'industry' },
      { field: 'description' },
      { field: 'payload' },
    ],
  },
]

export default defaultEncryptionMaps
