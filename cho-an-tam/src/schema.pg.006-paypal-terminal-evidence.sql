-- Also tighten databases that already applied the earlier v5 definition.
-- Refuse the upgrade if historical evidence is invalid; never relabel it as VOIDED.
ALTER TABLE app.paypal_payment_bindings
  DROP CONSTRAINT IF EXISTS paypal_terminal_evidence_order_voided;
ALTER TABLE app.paypal_payment_bindings
  ADD CONSTRAINT paypal_terminal_evidence_order_voided
  CHECK (not_captured_evidence IS NULL OR not_captured_evidence = 'ORDER_VOIDED');
