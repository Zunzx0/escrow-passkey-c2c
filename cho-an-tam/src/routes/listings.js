const express = require('express');

const { db, uuid, nowIso } = require('../db');
const { requireAuth, optionalAuth, requireRole } = require('../lib/auth');
const { AppError } = require('../lib/errors');
const { publicUsername } = require('../lib/username');
const {
  CATEGORIES,
  CATEGORY_KEYS,
  CONDITIONS,
  CONDITION_KEYS,
  LOCATIONS,
  RESERVING_STATUSES,
} = require('../lib/catalog');

const router = express.Router();

const RESERVING_PLACEHOLDERS = RESERVING_STATUSES.map(() => '?').join(',');

// is_sold: tin đăng đã có một đơn giữ chỗ hoặc đã bán hẳn. Mỗi tin là một sản phẩm đơn
// chiếc nên chỉ cần tồn tại một đơn như vậy là tin đăng ngừng nhận đơn mới.
// EXISTS bọc trong CASE để cả SQLite lẫn PostgreSQL đều trả về 0/1 (PostgreSQL trả boolean).
const SELECT_LISTING = `
  SELECT l.*,
         u.display_name AS seller_name,
         u.username     AS seller_username,
         CASE WHEN EXISTS(
           SELECT 1 FROM transactions t
           WHERE t.listing_id = l.id AND t.status IN (${RESERVING_PLACEHOLDERS})
         ) THEN 1 ELSE 0 END AS is_sold,
         (
           SELECT t2.status FROM transactions t2
           WHERE t2.listing_id = l.id AND t2.status IN (${RESERVING_PLACEHOLDERS})
           ORDER BY t2.created_at DESC LIMIT 1
         ) AS sold_status
  FROM listings l
  JOIN users u ON u.id = l.seller_id
`;

function serializeListing(row) {
  return {
    id: row.id,
    sellerId: row.seller_id,
    sellerName: row.seller_name,
    sellerUsername: publicUsername(row.seller_username),
    title: row.title,
    description: row.description,
    category: row.category,
    location: row.location || null,
    condition: row.condition,
    image: row.image,
    price: row.price,
    visibility: row.visibility,
    // Trạng thái khoá độc quyền của tin đăng (AVAILABLE | LOCKED | SOLD) — hàng rào LOCK.
    status: row.status,
    isSold: !!row.is_sold,
    soldStatus: row.is_sold ? (row.sold_status || null) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadListingOr404(id) {
  // Hai bộ tham số: một cho EXISTS(is_sold), một cho subquery sold_status.
  const row = await db
    .prepare(`${SELECT_LISTING} WHERE l.id = ?`)
    .get(...RESERVING_STATUSES, ...RESERVING_STATUSES, id);
  if (!row) throw new AppError(404, 'LISTING_NOT_FOUND', 'Không tìm thấy sản phẩm này');
  return row;
}

/** Chuẩn hoá + kiểm tra dữ liệu form đăng bán / sửa tin. */
function readListingInput(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body[k] !== undefined && body[k] !== null;
  const need = (k, label) => {
    if (!partial && !has(k)) throw new AppError(400, 'VALIDATION_ERROR', `Thiếu ${label}`);
  };

  need('title', 'tên sản phẩm');
  if (has('title')) {
    const title = String(body.title).trim();
    if (title.length < 2 || title.length > 120) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Tên sản phẩm phải dài 2–120 ký tự');
    }
    out.title = title;
  }

  if (has('description')) out.description = String(body.description).trim().slice(0, 2000) || null;
  if (has('image')) out.image = String(body.image).trim().slice(0, 500) || null;
  if (has('location')) {
    if (!LOCATIONS.includes(body.location)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Khu vực không hợp lệ');
    }
    out.location = body.location;
  }

  need('category', 'danh mục');
  if (has('category')) {
    if (!CATEGORY_KEYS.includes(body.category)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Danh mục không hợp lệ');
    }
    out.category = body.category;
  }

  if (has('condition')) {
    if (!CONDITION_KEYS.includes(body.condition)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Tình trạng sản phẩm không hợp lệ');
    }
    out.condition = body.condition;
  }

  need('price', 'giá bán');
  if (has('price')) {
    const price = Number(body.price);
    if (!Number.isInteger(price) || price < 1000 || price > 100000000) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Giá bán phải là số nguyên từ 1.000đ đến 100.000.000đ');
    }
    out.price = price;
  }

  if (has('visibility')) {
    if (body.visibility !== 'PUBLIC' && body.visibility !== 'HIDDEN') {
      throw new AppError(400, 'VALIDATION_ERROR', 'visibility phải là PUBLIC hoặc HIDDEN');
    }
    out.visibility = body.visibility;
  }

  return out;
}

// ---------- Metadata cho form & bộ lọc ----------

router.get('/meta', (req, res) => {
  res.json({ categories: CATEGORIES, conditions: CONDITIONS, locations: LOCATIONS });
});

// ---------- Danh sách (công khai) ----------

router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const { q, category, condition, location, maxPrice, sellerId, sort } = req.query;
    const mine = req.query.mine === 'true' || req.query.mine === '1';

    const where = [];
    // Hai bộ tham số: một cho EXISTS(is_sold), một cho subquery sold_status.
    const params = [...RESERVING_STATUSES, ...RESERVING_STATUSES];

    if (mine) {
      if (!req.user) throw new AppError(401, 'UNAUTHENTICATED', 'Cần đăng nhập để xem tin đăng của bạn');
      where.push('l.seller_id = ?');
      params.push(req.user.id);
    } else {
      // Khách và người mua chỉ thấy tin đang mở bán.
      where.push("l.visibility = 'PUBLIC'");
      if (sellerId) {
        where.push('l.seller_id = ?');
        params.push(sellerId);
      }
    }

    if (q) {
      // LOWER hai vế: LIKE của SQLite không phân biệt hoa thường, của PostgreSQL thì có.
      where.push('(LOWER(l.title) LIKE LOWER(?) OR LOWER(l.description) LIKE LOWER(?))');
      const like = `%${String(q).trim()}%`;
      params.push(like, like);
    }
    if (category && CATEGORY_KEYS.includes(category)) {
      where.push('l.category = ?');
      params.push(category);
    }
    if (condition && CONDITION_KEYS.includes(condition)) {
      where.push('l.condition = ?');
      params.push(condition);
    }
    if (location && LOCATIONS.includes(location)) {
      where.push('l.location = ?');
      params.push(location);
    }
    if (maxPrice) {
      const cap = Number(maxPrice);
      if (Number.isFinite(cap) && cap > 0) {
        where.push('l.price <= ?');
        params.push(Math.floor(cap));
      }
    }

    const orderBy =
      sort === 'price_asc' ? 'l.price ASC'
      : sort === 'price_desc' ? 'l.price DESC'
      : 'l.created_at DESC';

    // Hàng đã bán chìm xuống cuối để trang chủ luôn ưu tiên thứ còn mua được.
    const sql = `${SELECT_LISTING} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY is_sold ASC, ${orderBy} LIMIT 200`;
    const rows = await db.prepare(sql).all(...params);
    res.json({ listings: rows.map(serializeListing) });
  } catch (e) {
    next(e);
  }
});

// ---------- Tạo nhanh dữ liệu mẫu cho tin đăng của chính mình ----------

// Tin đăng mẫu: đồ đã qua sử dụng giữa các cá nhân — đúng loại hàng hoá C2C của Chương 1.
const DEMO_ITEMS = [
  { title: 'iPhone 13 128GB xanh, pin 89%', category: 'DIEN_THOAI', condition: 'GOOD', price: 9800000, location: 'Hà Nội',
    description: 'Máy chính chủ mua tại TGDĐ, không bể không sửa. Pin 89%, Face ID hoạt động tốt. Kèm hộp và cáp zin, đã dán cường lực.' },
  { title: 'MacBook Air M1 2020 8GB/256GB', category: 'MAY_TINH', condition: 'LIKE_NEW', price: 13500000, location: 'TP. Hồ Chí Minh',
    description: 'Sạc 124 lần, ngoại hình như mới, không trầy. Dùng văn phòng nhẹ nhàng. Tặng kèm túi chống sốc.' },
  { title: 'Tai nghe Sony WH-1000XM4 chống ồn', category: 'DIEN_TU', condition: 'GOOD', price: 3900000, location: 'Hà Nội',
    description: 'Chống ồn còn rất tốt, đệm tai đã thay mới. Đủ hộp, dây sạc, dây 3.5mm. Bảo hành hãng hết.' },
  { title: 'Máy ảnh Fujifilm X-T30 kèm lens 15-45mm', category: 'MAY_ANH', condition: 'LIKE_NEW', price: 14200000, location: 'Đà Nẵng',
    description: 'Shot count khoảng 6.000, cảm biến sạch. Kèm 2 pin, thẻ nhớ 64GB và dây đeo. Test máy thoải mái khi nhận.' },
  { title: 'Áo khoác da nam size L, đã mặc 3 lần', category: 'THOI_TRANG', condition: 'LIKE_NEW', price: 1150000, location: 'TP. Hồ Chí Minh',
    description: 'Da PU cao cấp, lót lụa. Mua về mặc không hợp dáng nên pass lại. Không phai màu, không bong tróc.' },
  { title: 'Nồi chiên không dầu Philips 4.1L', category: 'GIA_DUNG', condition: 'GOOD', price: 1250000, location: 'Hải Phòng',
    description: 'Dùng được khoảng 1 năm, vẫn nóng đều, giỏ chiên còn chống dính. Chuyển nhà nên bán lại.' },
  { title: 'Trọn bộ Harry Potter 7 tập bản đặc biệt', category: 'SACH', condition: 'GOOD', price: 850000, location: 'Hà Nội',
    description: 'Bản NXB Trẻ bìa cứng, đọc một lần, gáy sách còn phẳng. Không ghi chép, không ố vàng.' },
  { title: 'Xe đạp thể thao Giant ATX 27.5', category: 'THE_THAO', condition: 'GOOD', price: 5600000, location: 'Cần Thơ',
    description: 'Khung nhôm size M, phanh đĩa cơ, 24 tốc độ. Mới bảo dưỡng, thay xích và má phanh.' },
];

router.post('/demo-seed', requireAuth, requireRole('SELLER'), async (req, res, next) => {
  try {
    const now = nowIso();
    const insert = db.prepare(
      `INSERT INTO listings (id, seller_id, title, description, category, location, condition,
        price, visibility, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PUBLIC', 0, ?, ?)`
    );
    // Phép đếm nằm CÙNG giao dịch với lệnh chèn: hai lần bấm đồng thời không cùng thấy "chưa có
    // tin đăng" rồi cùng chèn bộ dữ liệu mẫu.
    await db.transaction(async () => {
      const existing = await db.prepare('SELECT COUNT(*) AS n FROM listings WHERE seller_id = ?').get(req.user.id);
      if (existing.n > 0) {
        throw new AppError(409, 'ALREADY_HAS_LISTINGS', 'Bạn đã có tin đăng — nút này chỉ dùng khi chưa đăng bán gì');
      }

      for (const item of DEMO_ITEMS) {
        await insert.run(uuid(), req.user.id, item.title, item.description, item.category, item.location,
          item.condition, item.price, now, now);
      }
    })();

    res.status(201).json({ created: DEMO_ITEMS.length });
  } catch (e) {
    next(e);
  }
});

// ---------- Chi tiết ----------

router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const row = await loadListingOr404(req.params.id);
    if (row.visibility === 'HIDDEN' && (!req.user || req.user.id !== row.seller_id)) {
      throw new AppError(404, 'LISTING_NOT_FOUND', 'Không tìm thấy sản phẩm này');
    }
    res.json(serializeListing(row));
  } catch (e) {
    next(e);
  }
});

// ---------- Đăng bán sản phẩm mới ----------

router.post('/', requireAuth, requireRole('SELLER'), async (req, res, next) => {
  try {
    const input = readListingInput(req.body || {});

    const id = uuid();
    const now = nowIso();
    await db.prepare(
      `INSERT INTO listings (id, seller_id, title, description, category, location, condition, image,
        price, visibility, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(
      id,
      req.user.id,
      input.title,
      input.description ?? null,
      input.category,
      input.location ?? null,
      input.condition ?? 'GOOD',
      input.image ?? null,
      input.price,
      input.visibility ?? 'PUBLIC',
      now,
      now
    );

    res.status(201).json(serializeListing(await loadListingOr404(id)));
  } catch (e) {
    next(e);
  }
});

// ---------- Sửa ----------

const FIELD_TO_COLUMN = {
  title: 'title',
  description: 'description',
  category: 'category',
  location: 'location',
  condition: 'condition',
  image: 'image',
  price: 'price',
  visibility: 'visibility',
};

router.patch('/:id', requireAuth, requireRole('SELLER'), async (req, res, next) => {
  try {
    const current = await loadListingOr404(req.params.id);
    if (current.seller_id !== req.user.id) {
      throw new AppError(403, 'FORBIDDEN', 'Bạn không phải người đăng bán sản phẩm này');
    }

    const input = readListingInput(req.body || {}, { partial: true });
    const keys = Object.keys(input);
    if (keys.length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'Không có trường nào để cập nhật');

    // Đổi giá khi đã có đơn giữ chỗ sẽ làm lệch số tiền đã khoá trong Escrow.
    if (current.is_sold && input.price !== undefined) {
      throw new AppError(409, 'LISTING_SOLD', 'Không thể đổi giá khi sản phẩm đã có đơn mua');
    }

    const assignments = keys.map((k) => `${FIELD_TO_COLUMN[k]} = ?`);
    const values = keys.map((k) => input[k]);
    const result = await db
      .prepare(
        `UPDATE listings SET ${assignments.join(', ')}, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`
      )
      .run(...values, nowIso(), current.id, current.version);
    if (result.changes !== 1) {
      throw new AppError(409, 'LISTING_VERSION_CONFLICT', 'Tin đăng vừa được cập nhật ở nơi khác, hãy tải lại');
    }

    res.json(serializeListing(await loadListingOr404(current.id)));
  } catch (e) {
    next(e);
  }
});

// ---------- Gỡ tin đăng ----------

router.delete('/:id', requireAuth, requireRole('SELLER'), async (req, res, next) => {
  try {
    // Kiểm "chưa có đơn" và xoá trong CÙNG một giao dịch: một đơn mua chen vào giữa lúc kiểm và
    // lúc xoá sẽ không làm mất tham chiếu tới tin đăng.
    const outcome = await db.transaction(async () => {
      const current = await loadListingOr404(req.params.id);
      if (current.seller_id !== req.user.id) {
        throw new AppError(403, 'FORBIDDEN', 'Bạn không phải người đăng bán sản phẩm này');
      }
      if (current.is_sold) {
        throw new AppError(409, 'LISTING_SOLD', 'Không thể gỡ khi sản phẩm đang có đơn mua hiệu lực');
      }

      const usedByOrder = await db.prepare('SELECT 1 FROM transactions WHERE listing_id = ? LIMIT 1').get(current.id);
      if (usedByOrder) {
        // Đã từng phát sinh đơn -> giữ lại bản ghi để lịch sử đơn không mất tham chiếu,
        // chỉ ẩn khỏi storefront.
        await db.prepare(`UPDATE listings SET visibility = 'HIDDEN', version = version + 1, updated_at = ? WHERE id = ?`)
          .run(nowIso(), current.id);
        return { deleted: false, hidden: true };
      }

      await db.prepare('DELETE FROM listings WHERE id = ?').run(current.id);
      return { deleted: true, hidden: false };
    })();
    res.json(outcome);
  } catch (e) {
    next(e);
  }
});

module.exports = { router, serializeListing, loadListingOr404 };
