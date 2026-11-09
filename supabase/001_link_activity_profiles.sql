-- Run once in the existing project's Supabase SQL Editor.
-- Adds person ownership without guessing ownership of any old records.
-- The new column uses the exact type of tempo_profiles.id.
BEGIN;

DO $$
DECLARE
    profile_id_type text;
BEGIN
    SELECT format_type(atttypid, atttypmod) INTO profile_id_type
    FROM pg_attribute
    WHERE attrelid = 'public.tempo_profiles'::regclass
      AND attname = 'id' AND NOT attisdropped;
    IF profile_id_type IS NULL THEN
        RAISE EXCEPTION 'tempo_profiles.id is required before activity ownership can be added';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.tempo_activity_log'::regclass
          AND attname = 'profile_id' AND NOT attisdropped
    ) THEN
        EXECUTE format('ALTER TABLE public.tempo_activity_log ADD COLUMN profile_id %s', profile_id_type);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public.tempo_activity_log'::regclass
                     AND conname = 'tempo_activity_log_profile_fk') THEN
        ALTER TABLE public.tempo_activity_log
            ADD CONSTRAINT tempo_activity_log_profile_fk
            FOREIGN KEY (profile_id) REFERENCES public.tempo_profiles(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public.tempo_activity_log'::regclass
                     AND conname = 'tempo_activity_log_new_records_need_profile') THEN
        -- Existing unassigned records stay untouched and cannot be used by the chat.
        -- New inserts and updates must provide a real profile ID.
        ALTER TABLE public.tempo_activity_log
            ADD CONSTRAINT tempo_activity_log_new_records_need_profile
            CHECK (profile_id IS NOT NULL) NOT VALID;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS tempo_activity_log_profile_time_idx
    ON public.tempo_activity_log (profile_id, created_at DESC, id DESC);

NOTIFY pgrst, 'reload schema';
COMMIT;
