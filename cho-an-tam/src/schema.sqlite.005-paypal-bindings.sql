-- PayPal durable bindings; provider discriminator already belongs to migration v4.
CREATE TABLE IF NOT EXISTS paypal_payment_bindings (
         payment_request_id TEXT PRIMARY KEY REFERENCES payment_requests(id) ON DELETE CASCADE,
         provider TEXT NOT NULL DEFAULT 'PAYPAL_SANDBOX' CHECK (provider = 'PAYPAL_SANDBOX'),
         quote_json TEXT NOT NULL,
         amount_vnd INTEGER NOT NULL CHECK (amount_vnd > 0),
         currency TEXT NOT NULL CHECK (currency = 'USD'),
         usd_cents INTEGER NOT NULL CHECK (usd_cents > 0),
         rate_vnd_per_usd INTEGER NOT NULL CHECK (rate_vnd_per_usd > 0),
         merchant_id TEXT NOT NULL,
         order_id TEXT UNIQUE,
         order_bound_at TEXT,
         create_attempt_at TEXT,
         capture_state TEXT NOT NULL DEFAULT 'READY' CHECK (capture_state IN ('READY','IN_FLIGHT','UNKNOWN','VERIFIED','NOT_CAPTURED','RECOVERY_REQUIRED')),
         capture_claim TEXT,
         capture_claimed_at TEXT,
         capture_attempts INTEGER NOT NULL DEFAULT 0,
         first_capture_at TEXT,
         capture_post_sent_at TEXT,
         capture_post_count INTEGER NOT NULL DEFAULT 0,
         capture_id TEXT UNIQUE,
         capture_verified_at TEXT,
         not_captured_evidence TEXT CHECK (not_captured_evidence IS NULL OR not_captured_evidence IN ('ORDER_VOIDED','CAPTURE_DECLINED')),
         recovery_required_at TEXT,
         last_capture_error TEXT,
         created_at TEXT NOT NULL,
         CHECK ((capture_state IN ('VERIFIED','RECOVERY_REQUIRED')) = (capture_id IS NOT NULL)),
         CHECK (capture_state <> 'IN_FLIGHT' OR capture_claim IS NOT NULL),
         CHECK (capture_state <> 'NOT_CAPTURED' OR not_captured_evidence IS NOT NULL),
         CHECK (capture_state <> 'RECOVERY_REQUIRED' OR recovery_required_at IS NOT NULL),
         CHECK (capture_state <> 'READY' OR capture_post_sent_at IS NULL),
         CHECK (capture_id IS NULL OR order_id IS NOT NULL)
       );

CREATE TRIGGER IF NOT EXISTS trg_paypal_binding_insert_guard
       BEFORE INSERT ON paypal_payment_bindings FOR EACH ROW WHEN NOT EXISTS (
         SELECT 1 FROM payment_requests pr
         WHERE pr.id = NEW.payment_request_id AND pr.provider = 'PAYPAL_SANDBOX' AND pr.amount = NEW.amount_vnd)
       BEGIN SELECT RAISE(ABORT, 'PAYPAL_BINDING_REQUEST_MISMATCH'); END;

CREATE TRIGGER IF NOT EXISTS trg_paypal_binding_immutable
       BEFORE UPDATE ON paypal_payment_bindings FOR EACH ROW WHEN
            NEW.payment_request_id IS NOT OLD.payment_request_id OR NEW.provider IS NOT OLD.provider
         OR NEW.quote_json IS NOT OLD.quote_json OR NEW.amount_vnd IS NOT OLD.amount_vnd
         OR NEW.currency IS NOT OLD.currency OR NEW.usd_cents IS NOT OLD.usd_cents
         OR NEW.rate_vnd_per_usd IS NOT OLD.rate_vnd_per_usd OR NEW.merchant_id IS NOT OLD.merchant_id
         OR NEW.created_at IS NOT OLD.created_at
         OR (OLD.order_id IS NOT NULL AND NEW.order_id IS NOT OLD.order_id)
         OR (OLD.create_attempt_at IS NOT NULL AND NEW.create_attempt_at IS NOT OLD.create_attempt_at)
         OR (OLD.capture_post_sent_at IS NOT NULL AND NEW.capture_post_sent_at IS NOT OLD.capture_post_sent_at)
         OR (OLD.capture_id IS NOT NULL AND NEW.capture_id IS NOT OLD.capture_id)
         OR (OLD.capture_state IN ('VERIFIED','RECOVERY_REQUIRED') AND NEW.capture_state IS NOT OLD.capture_state)
         OR (OLD.capture_state = 'NOT_CAPTURED' AND NEW.capture_state NOT IN ('NOT_CAPTURED','VERIFIED','RECOVERY_REQUIRED'))
       BEGIN SELECT RAISE(ABORT, 'PAYPAL_BINDING_IMMUTABLE'); END;
