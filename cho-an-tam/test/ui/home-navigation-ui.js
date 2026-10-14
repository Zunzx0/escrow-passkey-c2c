'use strict';

// Kiểm thử SPA thật bằng jsdom; mọi phản hồi API đều là dữ liệu giả tại chỗ.
const assert = require('node:assert/strict');
const { wallet, json, sleep } = require('./paypal-wallet-ui');

let checks = 0;
function ok(value, label) {
  assert.ok(value, label);
  checks++;
  console.log('✅ ' + label);
}

async function main() {
  const category = { key: 'DIEN_THOAI', label: 'Điện thoại', icon: 'smartphone' };
  const page = await wallet({
    hash: '#/',
    extra: {
      'GET /api/listings/meta': () => json(200, { categories: [category], conditions: [], locations: [] }),
      'GET /api/listings': () => json(200, { listings: [] }),
    },
  });

  try {
    const selectCategory = async () => {
      page.click(page.d.querySelector('[data-act="filter-cat"][data-cat="DIEN_THOAI"]'));
      await sleep(80);
    };

    await selectCategory();
    let breadcrumb = page.d.querySelector('.home-breadcrumb');
    ok(breadcrumb && /Trang chủ/.test(breadcrumb.textContent) && /Điện thoại/.test(breadcrumb.textContent),
      'Chọn danh mục hiển thị breadcrumb Trang chủ → danh mục');
    ok(page.w.location.hash === '#/', 'Bộ lọc danh mục vẫn hoạt động trên trang chợ hiện tại');

    page.click(breadcrumb.querySelector('[data-act="go-home"]'));
    await sleep(80);
    ok(!page.d.querySelector('.home-breadcrumb') && /Mua đồ cũ, không lo mất tiền/.test(page.viewText()),
      'Bấm Trang chủ trong breadcrumb xóa bộ lọc và trở về trang chủ đầy đủ');

    await selectCategory();
    page.click(page.d.querySelector('.brand[data-act="go-home"]'));
    await sleep(80);
    ok(!page.d.querySelector('.home-breadcrumb') && /Mua đồ cũ, không lo mất tiền/.test(page.viewText()),
      'Bấm logo vẫn về trang chủ dù URL trước và sau đều là #/');

    console.log(`${checks} kiểm tra điều hướng trang chủ đã đạt`);
  } finally {
    page.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
