-- Existing payments stay MOCK. Durable PayPal bindings follow in a separate migration.
ALTER TABLE app.payment_requests ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'MOCK'
  CHECK (provider IN ('MOCK','PAYPAL_SANDBOX'));
CREATE OR REPLACE FUNCTION app.guard_payment_provider() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION 'PAYMENT_PROVIDER_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS payment_provider_immutable ON app.payment_requests;
CREATE TRIGGER payment_provider_immutable BEFORE UPDATE OF provider ON app.payment_requests
  FOR EACH ROW EXECUTE FUNCTION app.guard_payment_provider();
