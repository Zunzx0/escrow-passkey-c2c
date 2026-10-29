-- Display references only. Existing reasons, decisions, money and audit stay intact.
ALTER TABLE app.disputes ADD COLUMN IF NOT EXISTS case_number INTEGER CHECK(case_number > 0);
ALTER TABLE app.disputes ADD COLUMN IF NOT EXISTS case_prefix TEXT CHECK(case_prefix IN ('A','B','C','D','E','F','G','L'));
CREATE TABLE IF NOT EXISTS app.dispute_case_counter(id INTEGER PRIMARY KEY CHECK(id=1),last_number INTEGER NOT NULL CHECK(last_number >= 0));

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM app.disputes WHERE (case_number IS NULL) <> (case_prefix IS NULL)) THEN
    RAISE EXCEPTION 'DISPUTE_REFERENCE_INCOMPLETE';
  END IF;
END $$;

INSERT INTO app.dispute_case_counter(id,last_number)
SELECT 1,COALESCE(MAX(case_number),0) FROM app.disputes
ON CONFLICT(id) DO UPDATE SET last_number=GREATEST(app.dispute_case_counter.last_number,EXCLUDED.last_number);

WITH missing AS (
  SELECT id,ROW_NUMBER() OVER(ORDER BY created_at,id)::INTEGER n,
    CASE type WHEN 'DAMAGED_GOODS' THEN 'A' WHEN 'NOT_AS_DESCRIBED' THEN 'B' WHEN 'MISSING_ITEMS' THEN 'C'
      WHEN 'NOT_SHIPPED' THEN 'D' WHEN 'NOT_RECEIVED' THEN 'E'
      WHEN 'INSPECTION_TIMEOUT' THEN 'F' WHEN 'SHIPMENT_STALLED' THEN 'G' ELSE 'L' END prefix
  FROM app.disputes WHERE case_number IS NULL
)
UPDATE app.disputes d SET case_number=counter.last_number+missing.n,case_prefix=missing.prefix
FROM missing,app.dispute_case_counter counter WHERE d.id=missing.id AND counter.id=1;

UPDATE app.dispute_case_counter SET last_number=GREATEST(last_number,(SELECT COALESCE(MAX(case_number),0) FROM app.disputes)) WHERE id=1;
CREATE UNIQUE INDEX IF NOT EXISTS ux_dispute_case_number ON app.disputes(case_number);
CREATE OR REPLACE FUNCTION app.keep_dispute_reference() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF (NEW.case_number IS NULL) <> (NEW.case_prefix IS NULL) THEN RAISE EXCEPTION 'DISPUTE_REFERENCE_INCOMPLETE'; END IF;
    IF NEW.case_number IS NULL THEN
      UPDATE app.dispute_case_counter SET last_number=last_number+1 WHERE id=1 RETURNING last_number INTO NEW.case_number;
      IF NOT FOUND THEN RAISE EXCEPTION 'DISPUTE_COUNTER_UNAVAILABLE'; END IF;
      NEW.case_prefix := CASE NEW.type WHEN 'DAMAGED_GOODS' THEN 'A' WHEN 'NOT_AS_DESCRIBED' THEN 'B'
        WHEN 'MISSING_ITEMS' THEN 'C' WHEN 'NOT_SHIPPED' THEN 'D' WHEN 'NOT_RECEIVED' THEN 'E'
        WHEN 'INSPECTION_TIMEOUT' THEN 'F' WHEN 'SHIPMENT_STALLED' THEN 'G' ELSE 'L' END;
    END IF;
  ELSIF OLD.case_number IS NOT NULL AND (NEW.case_number IS DISTINCT FROM OLD.case_number OR NEW.case_prefix IS DISTINCT FROM OLD.case_prefix) THEN
    RAISE EXCEPTION 'DISPUTE_REFERENCE_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS dispute_reference_immutable ON app.disputes;
CREATE TRIGGER dispute_reference_immutable BEFORE INSERT OR UPDATE OF case_number,case_prefix ON app.disputes FOR EACH ROW EXECUTE FUNCTION app.keep_dispute_reference();
