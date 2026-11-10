-- Run once in the Supabase SQL Editor (after 001). Safe to run again.
-- Lets the family check each recorded activity in the Timeline:
--   verification = 'correct'   the sensor was right
--                  'corrected' the sensor was wrong; activity now holds the right one, original_activity the sensor's label
--                  'rejected'  nothing happened (false detection); kept for the record, ignored by the assistant and reports
--                  NULL        not checked yet
BEGIN;

ALTER TABLE public.tempo_activity_log
    ADD COLUMN IF NOT EXISTS verification text,
    ADD COLUMN IF NOT EXISTS original_activity text,
    ADD COLUMN IF NOT EXISTS verified_by text,
    ADD COLUMN IF NOT EXISTS verified_at timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public.tempo_activity_log'::regclass
                     AND conname = 'tempo_activity_log_verification_check') THEN
        ALTER TABLE public.tempo_activity_log
            ADD CONSTRAINT tempo_activity_log_verification_check
            CHECK (verification IS NULL OR verification IN ('correct', 'corrected', 'rejected'));
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
