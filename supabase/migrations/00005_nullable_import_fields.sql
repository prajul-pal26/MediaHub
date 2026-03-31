-- Make group_id nullable on content_posts for imported posts (no media_group needed)
ALTER TABLE content_posts ALTER COLUMN group_id DROP NOT NULL;

-- Make asset_id nullable on publish_jobs for imported posts (no media_asset needed)
ALTER TABLE publish_jobs ALTER COLUMN asset_id DROP NOT NULL;
