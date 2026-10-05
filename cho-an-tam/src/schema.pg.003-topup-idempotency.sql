-- Migration PostgreSQL số 3: khoá chống lặp, trạng thái bước gửi provider và quyền gửi (lease) cho
-- yêu cầu nạp tiền (xem chú thích payment_requests trong schema.sql và src/lib/paymentService.js).
-- Yêu cầu có sẵn mặc định SUBMITTED; worker đối soát tự phát hiện yêu cầu provider không biết.

ALTER TABLE app.payment_requests ADD COLUMN IF NOT EXISTS client_request_id TEXT;
ALTER TABLE app.payment_requests ADD COLUMN IF NOT EXISTS submission_status TEXT NOT NULL DEFAULT 'SUBMITTED'
  CHECK (submission_status IN ('SUBMITTING','SUBMITTED','SUBMIT_FAILED'));
ALTER TABLE app.payment_requests ADD COLUMN IF NOT EXISTS submit_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app.payment_requests ADD COLUMN IF NOT EXISTS last_submit_error TEXT;
ALTER TABLE app.payment_requests ADD COLUMN IF NOT EXISTS submit_claim TEXT;
ALTER TABLE app.payment_requests ADD COLUMN IF NOT EXISTS submit_claimed_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_requests_client_request
  ON app.payment_requests(user_id, client_request_id) WHERE client_request_id IS NOT NULL;
