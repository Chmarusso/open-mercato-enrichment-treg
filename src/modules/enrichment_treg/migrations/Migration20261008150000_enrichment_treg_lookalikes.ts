import { Migration } from '@mikro-orm/migrations';

export class Migration20261008150000_enrichment_treg_lookalikes extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "enrichment_treg_lookalikes" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "seed_company_id" uuid not null, "record_id" uuid not null, "name" text not null, "domain" text not null, "website_url" text null, "industry" text null, "description" text null, "source" text null, "payload" jsonb not null, "dedupe_hash" text not null, "status" text not null default 'new', "crm_company_id" uuid null, "imported_at" timestamptz null, "imported_by_user_id" uuid null, "dismissed_at" timestamptz null, "dismissed_by_user_id" uuid null, "first_seen_at" timestamptz not null, "last_seen_at" timestamptz not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "enrichment_treg_lookalikes_list_idx" on "enrichment_treg_lookalikes" ("tenant_id", "organization_id", "seed_company_id", "status", "first_seen_at");`);
    this.addSql(`alter table "enrichment_treg_lookalikes" add constraint "enrichment_treg_lookalikes_dedupe_uq" unique ("tenant_id", "organization_id", "seed_company_id", "dedupe_hash");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "enrichment_treg_lookalikes" cascade;`);
  }

}
