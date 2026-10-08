# open-mercato-enrichment-treg

An [Open Mercato](https://github.com/open-mercato/open-mercato) module that enriches CRM people and companies with data fetched through [treg.to](https://treg.to), a pay-per-call gateway in front of 100+ data providers (PDL, Apollo, Hunter, Lusha and others).

Each person and company detail page gets an **Enrichment** tab. Click **Enrich with treg**, review the proposed values next to the current ones, tick the fields you want, and apply them. Nothing is written to the CRM until you apply.

## What it fills in

| Record | treg endpoint | Proposed fields | Shown for context |
|---|---|---|---|
| Person | `treg.people.enrich` | Job title, LinkedIn URL | Name, company, company domain, location |
| Company | `treg.companies.enrich` | Brand name, domain, website, industry, company size, description | Location, employees, founded |

Lookups use what the CRM already holds: a person's email, LinkedIn URL, or name plus company domain; a company's domain, website, name or email.

## Company signals

Company pages also get a **Company signals** section below the profile lookup. Tick **Hiring** and/or **News** and click **Refresh signals** to fetch open roles (`treg.companies.jobs.search`) and recent news (`treg.companies.news`). Results are stored per company without duplicates and listed newest first, with a link to the source. Signals are display-only; they are never written to CRM fields.

News needs the company's domain; hiring works with a domain or a name. A refresh within 24 hours of the last one asks for confirmation.

## Similar companies

Company pages also get a **Similar companies** section. Click **Find similar companies** to look up companies that resemble this one, seeded by its domain (or its website when the domain is empty). The lookup uses the free `leadsforge.companies.lookalike.preview` endpoint on treg, so it costs nothing.

Each result shows its name, domain, industry and description, with a status:

- **New**: not in the CRM yet.
- **In CRM**: a company with the same domain or website already exists. The row links to it.
- **Added**: you added it from this list. The row links to the new company.
- **Dismissed**: hidden. Use **Show dismissed** to see these rows.

Tick **New** rows and click **Add to CRM** to create them as CRM companies with their name, domain, website, industry and description. Companies are created through the normal customers API, so permissions, audit and undo work as usual. **Add to CRM** only appears for users with `customers.companies.manage`. Searching again adds only companies not seen before and keeps every status.

Company domains are encrypted in the CRM, so matching against existing companies decrypts them in batches. Above 20,000 companies the match is skipped and the section shows a warning.

## Install

Requires Open Mercato 0.8 or newer.

```bash
yarn add open-mercato-enrichment-treg
yarn mercato module add open-mercato-enrichment-treg --allow-third-party
yarn generate
yarn mercato db:migrate
yarn mercato auth sync-role-acls
```

Then open **Integrations → treg Enrichment**, paste your treg API token and enable the integration.

## Configuration

| Credential | Required | Notes |
|---|---|---|
| treg API token | yes | Org token from treg.to, sent as `X-Treg-Token` |
| treg team slug | no | Only for identity tokens, sent as `X-Treg-Org` |
| Max cost per call (USD) | no | Hard ceiling treg enforces per call; default `0.05` |
| API base URL | no | Leave empty for production. Must be `https`; `http` is accepted only for `localhost` / `127.0.0.1` test stubs |

### Environment preset

New tenants are configured automatically when these are set:

| Variable | Meaning |
|---|---|
| `OM_INTEGRATION_TREG_API_TOKEN` | API token (enables the preset) |
| `OM_INTEGRATION_TREG_ORG_SLUG` | Team slug |
| `OM_INTEGRATION_TREG_MAX_COST_PER_CALL_USD` | Per-call ceiling |
| `OM_INTEGRATION_TREG_API_BASE_URL` | Base URL override |
| `OM_INTEGRATION_TREG_ENABLED` | Enable the integration (default `true`) |
| `OM_INTEGRATION_TREG_FORCE_PRECONFIGURE` | Overwrite existing credentials (default `false`) |

## Costs

treg charges per successful lookup (people from about $0.003, companies from about $0.002). Misses on per-success providers are free. Every call carries an `Idempotency-Key`, so queue retries are not charged twice, and the per-call ceiling caps waterfall spend.

Signal lookups cost more: treg tries providers in turn and some bill for misses, so expect up to about $0.04 per kind ($0.08 for hiring plus news). A company unknown to the news providers is answered with a free miss. Name-only hiring lookups can need a provider above the default $0.05 ceiling and are then refused without charge; add a domain or raise the ceiling.

## Privacy

Enrichment sends names, emails and LinkedIn URLs to treg.to and its upstream providers. The integration is disabled until a tenant enables it, lookups only run when a user clicks the button, and lookup inputs, results and raw payloads are encrypted at rest when tenant encryption is on. Make sure your tenant has a lawful basis for this processing.

## Permissions

| Feature | Default roles |
|---|---|
| `enrichment_treg.view` | superadmin, admin, employee |
| `enrichment_treg.run` | superadmin, admin, employee |
| `enrichment_treg.configure` | superadmin, admin |

Every enrichment route also requires the customers view permission for the record type (`customers.people.view` or `customers.companies.view`), and applying fields requires the normal customers edit permission (`customers.people.manage` or `customers.companies.manage`). Existing tenants get the new features after `yarn mercato auth sync-role-acls`.

## Operations

- Failed lookups are written to the integration's **Logs** tab at error level.
- Creating a lookup and marking fields as applied are undoable commands; the CRM change itself is undone through the normal customers undo.
- A lookup stuck in `running` for more than 5 minutes (for example after a worker restart) is resumed on the next delivery without a second charge.

## API

| Method | Path | Feature |
|---|---|---|
| POST | `/api/enrichment_treg/enrich` | `enrichment_treg.run` |
| GET | `/api/enrichment_treg/records?subjectType=&subjectId=` | `enrichment_treg.view` |
| POST | `/api/enrichment_treg/records/:id/applied` | `enrichment_treg.run` |
| POST | `/api/enrichment_treg/signals/refresh` | `enrichment_treg.run` |
| GET | `/api/enrichment_treg/signals?subjectId=&signalType=` | `enrichment_treg.view` |
| POST | `/api/enrichment_treg/lookalikes/refresh` | `enrichment_treg.run` |
| GET | `/api/enrichment_treg/lookalikes?companyId=&status=&ids=` | `enrichment_treg.view` |
| POST | `/api/enrichment_treg/lookalikes/:id/imported` | `enrichment_treg.run` |
| POST | `/api/enrichment_treg/lookalikes/:id/dismiss` | `enrichment_treg.run` |

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Playwright specs in `src/modules/enrichment_treg/__integration__/` run against an Open Mercato app with this module enabled; they start a local treg stub and skip themselves when the tenant already has real treg credentials. The design spec is in [`docs/spec.md`](docs/spec.md).

## License

MIT
