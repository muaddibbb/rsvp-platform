-- Picture P1: optional event picture. Additive and re-runnable.
alter table public.events add column if not exists picture_path text;

-- Owner steps in the Supabase dashboard (Storage), before the endpoint is used:
--   1. Create bucket "picture-staging": Public OFF (private), file size limit 1.5 MB, allowed MIME types image/jpeg.
--   2. Create bucket "event-pictures": Public ON, file size limit 1.5 MB, allowed MIME types image/jpeg.
--   3. Add NO policies on storage.objects (only the service role writes, through api/picture-upload.js).
--   SECURITY: the 1.5 MB file size limit on BOTH buckets is a security dependency (the endpoint cannot stop an oversize upload to the signed URL). Test it: a 2 MB upload must be refused.
