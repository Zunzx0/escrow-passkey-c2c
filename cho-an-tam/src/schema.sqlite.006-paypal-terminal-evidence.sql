-- Existing SQLite tables keep their original CHECK, so enforce the tighter rule on writes.
CREATE TRIGGER IF NOT EXISTS trg_paypal_terminal_evidence_insert
BEFORE INSERT ON paypal_payment_bindings
FOR EACH ROW WHEN NEW.not_captured_evidence IS NOT NULL AND NEW.not_captured_evidence <> 'ORDER_VOIDED'
BEGIN SELECT RAISE(ABORT, 'PAYPAL_TERMINAL_EVIDENCE_INVALID'); END;
CREATE TRIGGER IF NOT EXISTS trg_paypal_terminal_evidence_update
BEFORE UPDATE ON paypal_payment_bindings
FOR EACH ROW WHEN NEW.not_captured_evidence IS NOT NULL AND NEW.not_captured_evidence <> 'ORDER_VOIDED'
BEGIN SELECT RAISE(ABORT, 'PAYPAL_TERMINAL_EVIDENCE_INVALID'); END;
