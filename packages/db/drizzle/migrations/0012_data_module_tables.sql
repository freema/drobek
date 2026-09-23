-- NSO-300 (M1-03): the pre-module Data API tables `collections`,
-- `app_documents` and the enum `collection_access_mode` now belong to the
-- platform module `data` (modules/data, drobek-module-data). Its first
-- migration (journal __drizzle_migrations_mod_data) imports every collection
-- into the app's `module_configs` row (access_mode → per-operation rules) and
-- every live document into `mod_data_documents`, then drops the old tables.
-- Core only forgets them here, so a server without the data module never
-- loses the stored records.
SELECT 1;
