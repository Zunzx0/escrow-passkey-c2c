// Startup repairs only known completed sales. A refund does not establish who
// physically holds the item, so no legacy refunded listing is reopened here.
// No database import: db.js uses this module during its own initialization.
function normalizeSettledListingsSql(schema, nowExpr) {
  return {
    sold: `UPDATE ${schema}listings SET status='SOLD',version=version+1,updated_at=${nowExpr}
      WHERE status='LOCKED' AND EXISTS(SELECT 1 FROM ${schema}transactions t
        WHERE t.listing_id=${schema}listings.id AND t.status IN ('COMPLETED','RELEASED'))`,
    reopened: `UPDATE ${schema}listings SET status=status WHERE 1=0`,
  };
}
module.exports={normalizeSettledListingsSql};
