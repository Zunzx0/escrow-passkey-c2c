import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/utils/password";

const prisma = new PrismaClient();

// Production does not create a predictable administrator. Set BOTH variables
// explicitly when a deployment needs a bootstrap admin; local development
// keeps a harmless demo default.
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const ADMIN_EMAIL = process.env.ADMIN_SEED_EMAIL ?? (IS_PRODUCTION ? undefined : "admin@example.com");
const ADMIN_DEMO_PASSWORD = process.env.ADMIN_SEED_PASSWORD ?? (IS_PRODUCTION ? undefined : "AdminDemo123!");

async function main() {
  const existingEscrow = await prisma.wallet.findFirst({ where: { isEscrow: true } });
  if (!existingEscrow) {
    await prisma.wallet.create({
      data: { isEscrow: true, userId: null, availableBalance: 0, lockedBalance: 0 },
    });
    console.log("Created the single Escrow wallet.");
  } else {
    console.log("Escrow wallet already exists, skipping.");
  }

  const existingAdmin = ADMIN_EMAIL ? await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } }) : null;
  if (ADMIN_EMAIL && ADMIN_DEMO_PASSWORD && !existingAdmin) {
    const passwordHash = await hashPassword(ADMIN_DEMO_PASSWORD);
    await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash,
        displayName: "Admin",
        role: "ADMIN",
        accountStatus: "PENDING_PASSKEY",
      },
    });
    console.log(`Created ADMIN account shell for ${ADMIN_EMAIL} (accountStatus=PENDING_PASSKEY).`);
  } else if (!ADMIN_EMAIL || !ADMIN_DEMO_PASSWORD) {
    console.log("Skipped ADMIN bootstrap because production admin seed variables were not provided.");
  } else {
    console.log("Admin account already exists, skipping.");
  }

  await seedDemoMarketplace();
}

// ---------------------------------------------------------------------
// Demo marketplace content (the TODO left here at Stage 1, now that
// Listings exist). These accounts exist ONLY to own listings so the
// marketplace UI has something to render — you still register your own
// account through the real POST /api/auth/register + Passkey flow and
// buy from them. They are deliberately left PENDING_PASSKEY: a Passkey
// cannot be seeded (WebAuthn needs a real authenticator), and ACTIVE is
// defined as "has registered a first Passkey", so marking them ACTIVE
// here would put a lie in the data.
// ---------------------------------------------------------------------
const DEMO_SELLER_PASSWORD = process.env.DEMO_SEED_PASSWORD ?? "DemoSeller123!";

const DEMO_SELLERS = [
  { email: "demo.seller1@example.com", displayName: "Minh Anh" },
  { email: "demo.seller2@example.com", displayName: "Quốc Huy" },
];

// `image` names a file in frontend/public/demo/ — stored as a root-relative
// URL so it resolves against whatever origin serves the app. Deliberately NOT
// a random-photo service: the previous seed used picsum, which paired an
// iPhone listing with a photo of flowers and made the whole marketplace look
// like throwaway test data.
type DemoListing = { title: string; description: string; price: number; image: string; seller: number; hoursAgo: number };

// Every title below was chosen to match what is ACTUALLY visible in its photo
// (each image was opened and checked, not trusted from its filename): the
// Samsung shots got Samsung titles, the Canon body got a Canon title, the LG
// panels got LG titles, and so on. If you change a title here, re-check the
// image — a listing whose photo shows a different product is the single most
// "fake demo data" thing a marketplace can do.
const DEMO_LISTINGS: DemoListing[] = [
  { title: "iPhone 15 Pro 256GB", description: "Máy đẹp không trầy, pin 97%, kèm hộp và cáp sạc gốc.", price: 24_500_000, image: "phone-iphone", seller: 0, hoursAgo: 0.2 },
  { title: "Samsung Galaxy S24 Ultra 512GB", description: "Nguyên zin, kèm bút S-Pen, còn bảo hành hãng 8 tháng.", price: 22_900_000, image: "phone-samsung", seller: 1, hoursAgo: 0.7 },
  { title: "MacBook Air M2 8GB/256GB", description: "Sạc 84 lần, máy chạy mát, phù hợp học tập và văn phòng.", price: 19_500_000, image: "laptop-macbook", seller: 0, hoursAgo: 1.6 },
  { title: "iPad Pro 11 inch + Apple Pencil", description: "Màn hình không điểm chết, kèm bút và bao da nam châm.", price: 15_900_000, image: "tablet-ipad", seller: 1, hoursAgo: 2.6 },
  { title: "Tai nghe Sony WH-1000XM4", description: "Chống ồn rất tốt, pin còn khoẻ, đủ hộp và dây sạc.", price: 4_900_000, image: "headphones-sony", seller: 0, hoursAgo: 4 },
  { title: "PlayStation 5 bản ổ đĩa", description: "Kèm 2 tay cầm DualSense và 3 đĩa game, máy hoạt động ổn định.", price: 12_500_000, image: "console-ps5", seller: 1, hoursAgo: 6 },
  { title: "Canon EOS 90D + lens 18-135mm", description: "Shutter count thấp, kèm thẻ nhớ 64GB và túi đựng.", price: 18_900_000, image: "camera-canon", seller: 0, hoursAgo: 9 },
  { title: "Apple Watch Series 5 44mm", description: "Pin còn tốt, kèm 2 dây đeo, mặt kính không xước.", price: 4_200_000, image: "watch-apple", seller: 1, hoursAgo: 12 },
  { title: "Dell XPS 13 Plus i7 16GB", description: "Máy mỏng nhẹ, vỏ trắng còn rất đẹp, pin dùng được 7 tiếng.", price: 21_000_000, image: "laptop-business", seller: 0, hoursAgo: 16 },
  { title: "AirPods Pro 2", description: "Chính hãng VN/A, còn bảo hành, hộp sạc pin tốt.", price: 4_100_000, image: "earbuds-airpods", seller: 1, hoursAgo: 20 },
  { title: "Nintendo Switch kèm 2 Joy-Con", description: "Máy đẹp, kèm dock và 2 game bản quyền.", price: 6_800_000, image: "console-switch", seller: 0, hoursAgo: 26 },
  { title: "Bàn phím cơ Keychron K2 switch brown", description: "Kết nối Bluetooth và có dây, keycap PBT thay mới.", price: 1_450_000, image: "keyboard", seller: 1, hoursAgo: 31 },
  { title: "Máy ảnh Panasonic Lumix G9 + 12-60mm", description: "Chống rung tốt, quay 4K, kèm 2 pin và sạc rời.", price: 16_500_000, image: "camera-mirrorless", seller: 0, hoursAgo: 38 },
  { title: "Màn hình LG UltraGear 27 inch 144Hz", description: "Chuyên game, phản hồi 1ms, không hở sáng, kèm dây HDMI.", price: 5_200_000, image: "monitor-dell", seller: 1, hoursAgo: 44 },
  { title: "Chuột không dây Logitech G305", description: "Pin AA dùng vài tháng, click còn đanh, kèm receiver.", price: 690_000, image: "mouse", seller: 0, hoursAgo: 52 },
  { title: "iPhone 13 128GB", description: "Pin 89%, máy dùng kỹ, không trầy xước, đầy đủ phụ kiện.", price: 11_500_000, image: "phone-iphone2", seller: 1, hoursAgo: 60 },
  { title: "Ống kính Canon EF 85mm f/1.4", description: "Kính trong, không rễ tre, khẩu lớn chụp chân dung rất đẹp.", price: 9_800_000, image: "camera-sony", seller: 0, hoursAgo: 68 },
  { title: "Loa JBL Flip 5 chống nước", description: "Pin khoảng 12 tiếng, âm bass chắc, còn mới 95%.", price: 1_750_000, image: "speaker-jbl", seller: 1, hoursAgo: 76 },
  { title: "Laptop Dell Latitude 7420 i7 16GB", description: "Máy văn phòng bền, bàn phím êm, kèm sạc gốc.", price: 12_400_000, image: "laptop-dell", seller: 0, hoursAgo: 85 },
  { title: "Kindle Paperwhite gen 11", description: "Đèn nền chỉnh màu, chống nước, kèm bao da.", price: 2_650_000, image: "ereader-kindle", seller: 1, hoursAgo: 94 },
  { title: "Apple Watch SE 44mm", description: "Máy đẹp, pin ổn, kèm dây silicon đen nguyên bản.", price: 5_600_000, image: "watch-smart", seller: 0, hoursAgo: 104 },
  { title: "Robot hút bụi lau nhà", description: "Lực hút mạnh, tự động lập bản đồ, giẻ lau còn mới.", price: 4_300_000, image: "vacuum-robot", seller: 1, hoursAgo: 116 },
  { title: "Samsung Galaxy S24+ 256GB", description: "Máy đẹp như mới, còn nguyên hộp, kèm củ sạc nhanh.", price: 16_900_000, image: "phone-android", seller: 0, hoursAgo: 128 },
  { title: "Xe đạp đua khung carbon", description: "Size M, vừa thay lốp và bảo dưỡng toàn bộ, đi rất nhẹ.", price: 14_500_000, image: "bicycle", seller: 1, hoursAgo: 140 },
  { title: "Màn hình LG 27 inch 4K IPS", description: "Màu chuẩn cho làm đồ hoạ, kèm chân đế chỉnh độ cao.", price: 6_800_000, image: "monitor-clean", seller: 0, hoursAgo: 152 },
];

async function seedDemoMarketplace() {
  const passwordHash = await hashPassword(DEMO_SELLER_PASSWORD);
  const sellerIds: string[] = [];
  for (const seller of DEMO_SELLERS) {
    const existing = await prisma.user.findUnique({ where: { email: seller.email } });
    if (existing) {
      sellerIds.push(existing.id);
      continue;
    }
    const user = await prisma.user.create({
      data: {
        email: seller.email,
        passwordHash,
        displayName: seller.displayName,
        role: "MEMBER",
        accountStatus: "PENDING_PASSKEY",
        // Needed so money can actually be credited to them on RELEASE.
        wallet: { create: {} },
      },
    });
    sellerIds.push(user.id);
  }

  // Refresh the demo catalogue. Only listings with NO transaction are removed:
  // anything already bought is left untouched so a demo purchase in progress
  // never breaks (and so this can't cascade into financial rows).
  const existingDemoListings = await prisma.listing.findMany({
    where: { sellerId: { in: sellerIds } },
    select: { id: true, title: true, _count: { select: { transactions: true } } },
  });
  const removableIds = existingDemoListings.filter((l) => l._count.transactions === 0).map((l) => l.id);
  const keptTitles = new Set(existingDemoListings.filter((l) => l._count.transactions > 0).map((l) => l.title));

  if (removableIds.length > 0) {
    await prisma.listingImage.deleteMany({ where: { listingId: { in: removableIds } } });
    await prisma.listing.deleteMany({ where: { id: { in: removableIds } } });
  }

  let created = 0;
  for (const item of DEMO_LISTINGS) {
    if (keptTitles.has(item.title)) continue;
    await prisma.listing.create({
      data: {
        sellerId: sellerIds[item.seller],
        title: item.title,
        description: item.description,
        price: item.price,
        createdAt: new Date(Date.now() - item.hoursAgo * 60 * 60 * 1000),
        images: { create: [{ url: `/demo/${item.image}.jpg`, position: 0 }] },
      },
    });
    created++;
  }

  console.log(
    `Demo marketplace refreshed: ${created} listings created, ${removableIds.length} old ones replaced, ` +
      `${keptTitles.size} kept (already have transactions). ` +
      `[DEV/SEED-ONLY catalogue accounts are not active until a real Passkey is registered.]`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
