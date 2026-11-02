-- READ-ONLY. Supabase → SQL Editor → New query → paste the whole file → Run. Returns ONE row with ONE cell
-- (schema_export) holding the definitions of the public tables as JSON: columns, constraints, indexes,
-- triggers, RLS flags, policies, grants, plus enums, views and function names. It reads only catalog views and
-- no table rows, so no customer data. Click the cell → copy, and send it to the team.
with
tbls as (
  select c.oid, c.relname as table_name, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
),
cols as (
  select table_name, jsonb_agg(jsonb_build_object(
    'column', column_name, 'type', data_type, 'udt', udt_name, 'nullable', is_nullable,
    'default', column_default, 'identity', is_identity, 'max_length', character_maximum_length
  ) order by ordinal_position) as columns
  from information_schema.columns where table_schema = 'public' group by table_name
),
cons as (
  select conrelid, jsonb_agg(jsonb_build_object('name', conname, 'type', contype, 'definition', pg_get_constraintdef(oid)) order by conname) as constraints
  from pg_constraint where connamespace = 'public'::regnamespace group by conrelid
),
idx as (
  select tablename, jsonb_agg(jsonb_build_object('name', indexname, 'definition', indexdef) order by indexname) as indexes
  from pg_indexes where schemaname = 'public' group by tablename
),
trg as (
  select tgrelid, jsonb_agg(jsonb_build_object('name', tgname, 'definition', pg_get_triggerdef(oid)) order by tgname) as triggers
  from pg_trigger where not tgisinternal group by tgrelid
),
pol as (
  select tablename, jsonb_agg(jsonb_build_object('name', policyname, 'permissive', permissive, 'roles', roles, 'command', cmd, 'using', qual, 'with_check', with_check) order by policyname) as policies
  from pg_policies where schemaname = 'public' group by tablename
),
grt as (
  select table_name, jsonb_agg(jsonb_build_object('grantee', grantee, 'privilege', privilege_type) order by grantee, privilege_type) as grants
  from information_schema.role_table_grants where table_schema = 'public' group by table_name
)
select jsonb_pretty(jsonb_build_object(
  'exported_at', now(),
  'postgres_version', current_setting('server_version'),
  'tables', coalesce((select jsonb_agg(jsonb_build_object(
      'table', t.table_name, 'rls_enabled', t.rls_enabled, 'rls_forced', t.rls_forced,
      'columns', coalesce(c.columns, '[]'::jsonb), 'constraints', coalesce(k.constraints, '[]'::jsonb),
      'indexes', coalesce(i.indexes, '[]'::jsonb), 'triggers', coalesce(g.triggers, '[]'::jsonb),
      'policies', coalesce(p.policies, '[]'::jsonb), 'grants', coalesce(r.grants, '[]'::jsonb)
    ) order by t.table_name)
    from tbls t
    left join cols c on c.table_name = t.table_name
    left join cons k on k.conrelid = t.oid
    left join idx i on i.tablename = t.table_name
    left join trg g on g.tgrelid = t.oid
    left join pol p on p.tablename = t.table_name
    left join grt r on r.table_name = t.table_name), '[]'::jsonb),
  'enums', coalesce((select jsonb_agg(jsonb_build_object('type', t.typname, 'labels', (select jsonb_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid)) order by t.typname)
    from pg_type t where t.typnamespace = 'public'::regnamespace and t.typtype = 'e'), '[]'::jsonb),
  'views', coalesce((select jsonb_agg(jsonb_build_object('view', viewname, 'definition', definition) order by viewname) from pg_views where schemaname = 'public'), '[]'::jsonb),
  'functions', coalesce((select jsonb_agg(jsonb_build_object('name', p.proname, 'args', pg_get_function_identity_arguments(p.oid)) order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace), '[]'::jsonb)
)) as schema_export;
