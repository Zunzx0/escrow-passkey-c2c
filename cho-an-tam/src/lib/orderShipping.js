const crypto = require('crypto');
const { db,  nowIso } = require('../db');
const { AppError } = require('./errors');
function readShipping(raw) {
  const fields = {}, out = {};
  const limits = {
    recipientName: [2,60], phone: [1,24], address: [10,200], ward: [1,80], district: [1,80], province: [1,80]
  };
  for (const [key,[min,max]] of Object.entries(limits)) {
    const value = typeof raw?.[key] === 'string' ? raw[key].trim().normalize('NFC') : '';
    out[key] = value;
    if (value.length < min || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fields[key] = `Thông tin phải dài ${min}–${max} ký tự hợp lệ.`;
  }
  out.phone = out.phone.replace(/[\s.()-]/g,'');
  if (!/^(?:0|\+84|84)[35789]\d{8}$/.test(out.phone)) fields.phone = 'Nhập số điện thoại Việt Nam hợp lệ.';
  if (Object.keys(fields).length) {
    const error = new AppError(400,'SHIPPING_VALIDATION','Hãy kiểm tra thông tin nhận hàng.');
    error.details = {
      fields
    };
    throw error;
  }
  return out;
}

function shippingHash(shipping) {
  return crypto.createHash('sha256').update(JSON.stringify(shipping)).digest('hex');
}

function serializeShipping(s) {
  return s ? {
    recipientName:s.recipient_name,
    phone:s.phone,
    address:s.address,
    ward:s.ward,
    district:s.district,
    province:s.province,
    version:s.version,
    createdAt:s.created_at,
    updatedAt:s.updated_at,
    lockedAt:s.locked_at
  }
  : null;
}

async function loadShipping(orderId) {
  return db.prepare('SELECT * FROM order_shipping_snapshot WHERE order_id=?').get(orderId);
}

async function insertShipping(orderId,s) {
  const at=nowIso();
  await db.prepare('INSERT INTO order_shipping_snapshot(order_id,recipient_name,phone,address,ward,district,province,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,?,?)').run(orderId,s.recipientName,s.phone,s.address,s.ward,s.district,s.province,at,at);
}
module.exports={
  readShipping,shippingHash,serializeShipping,loadShipping,insertShipping
};
