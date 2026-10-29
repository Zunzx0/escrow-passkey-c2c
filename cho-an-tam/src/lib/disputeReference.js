'use strict';

// Human references are display metadata, never authorization or settlement inputs.
const LEGACY = Object.freeze({ code: 'L', label: 'Vấn đề sản phẩm — chưa tách loại' });
const CATEGORIES = Object.freeze({
  DAMAGED_GOODS: { code: 'A', label: 'Hàng hỏng hoặc có lỗi' },
  NOT_AS_DESCRIBED: { code: 'B', label: 'Hàng không đúng mô tả' },
  MISSING_ITEMS: { code: 'C', label: 'Thiếu hàng hoặc phụ kiện' },
  NOT_SHIPPED: { code: 'D', label: 'Người bán chưa gửi hàng' },
  NOT_RECEIVED: { code: 'E', label: 'Chưa nhận được hàng' },
  INSPECTION_TIMEOUT: { code: 'F', label: 'Quá hạn kiểm hàng — hệ thống tự mở' },
  SHIPMENT_STALLED: { code: 'G', label: 'Giao hàng quá hạn — hệ thống tự mở' },
  DEFECT: LEGACY, // Backward-compatible, historically combined product complaints.
});
const CATEGORY_BY_CODE = Object.freeze(Object.fromEntries(Object.values(CATEGORIES).map(c => [c.code, c])));
const MANUAL_TYPES = Object.freeze(['DAMAGED_GOODS', 'NOT_AS_DESCRIBED', 'MISSING_ITEMS', 'NOT_SHIPPED', 'NOT_RECEIVED', 'DEFECT']);
const categoryForType = type => Object.hasOwn(CATEGORIES, type) ? CATEGORIES[type] : LEGACY;

function initialCategory(d) {
  // Historical DEFECT combined damage, missing goods and description mismatch.
  // Do not guess a more specific allegation from free text during migration.
  return d.type === 'DEFECT' ? LEGACY : categoryForType(d.type);
}

function referenceFields(d) {
  const number = Number(d.case_number), prefix = d.case_prefix;
  const valid = Number.isSafeInteger(number) && number > 0 && Object.hasOwn(CATEGORY_BY_CODE, prefix);
  const current = categoryForType(d.type);
  return {
    caseCode: valid ? prefix + number : null,
    caseNumber: valid ? number : null,
    casePrefix: valid ? prefix : null,
    categoryCode: current.code,
    typeLabel: current.label,
    originalTypeLabel: valid ? CATEGORY_BY_CODE[prefix].label : null,
  };
}

module.exports = { CATEGORIES, CATEGORY_BY_CODE, MANUAL_TYPES, initialCategory, referenceFields };
