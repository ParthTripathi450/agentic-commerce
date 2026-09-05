-- Run this in the Supabase SQL Editor BEFORE pg_restore.
--
-- The dump was taken from a database where pgvector lives in `public`, so it
-- refers to `public.vector(384)` and `public.vector_cosine_ops` by name, with
-- search_path set to ''. Supabase installs extensions into `extensions` by
-- default, and a plain `CREATE EXTENSION IF NOT EXISTS vector` is then a no-op
-- that leaves the type in the wrong schema — the restore fails on every table
-- with an embedding column, and on both vector indexes.
--
-- This puts them where the dump expects, whichever state the project is in.

-- pgvector: create in public, or move an existing one there.
DO $$
DECLARE current_schema_name text;
BEGIN
  SELECT n.nspname INTO current_schema_name
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'vector';

  IF current_schema_name IS NULL THEN
    CREATE EXTENSION vector WITH SCHEMA public;
    RAISE NOTICE 'pgvector created in public';
  ELSIF current_schema_name <> 'public' THEN
    ALTER EXTENSION vector SET SCHEMA public;
    RAISE NOTICE 'pgvector moved from % to public', current_schema_name;
  ELSE
    RAISE NOTICE 'pgvector already in public';
  END IF;
END $$;

-- pgcrypto: the dump does not reference it by schema, so anywhere works. It is
-- created only so the schema matches the source.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Confirm before restoring. `vector` MUST read `public`.
SELECT e.extname, n.nspname AS schema
FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE e.extname IN ('vector', 'pgcrypto');
