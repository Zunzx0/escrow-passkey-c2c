// Luồng đăng ký và đăng nhập theo mô hình xác thực LAI (mục 2.2.5 của đồ án).
//
// Hai mức quyền:
//   Mức 1 — mở một phiên làm việc. Chấp nhận mật khẩu HOẶC Passkey.
//   Mức 2 — phê duyệt thao tác làm tiền rời khỏi ký quỹ hoặc thay đổi thông tin xác thực.
//           Chỉ chấp nhận Passkey, qua cơ chế xác thực lại ở mục 2.2.6.
//
// Mức 1 KHÔNG đồng nghĩa với "không chạm tới tiền": một phiên hợp lệ vẫn tạo được giao
// dịch và vẫn khoá được tiền vào ký quỹ. Ranh giới nằm ở chiều tiền đi RA.
//
// Để mức 2 luôn khả dụng, đăng ký Passkey là bước BẮT BUỘC để hoàn tất tài khoản: không
// tồn tại tài khoản đang hoạt động nào chỉ có mật khẩu. Đây là điểm phân biệt với cách bổ
// sung Passkey như một tuỳ chọn đặt cạnh mật khẩu, ở đó mức bảo đảm chung hạ xuống bằng
// mức của lối yếu nhất.
const express = require('express');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const { db, uuid, nowIso } = require('../db');
const {
  signAccessToken,
  requireAuth,
  requireEnrollAuth,
  requireAccountStatus,
  scopeForStatus,
} = require('../lib/auth');
const { rateLimit } = require('../lib/rateLimit');
const {
  ACTIONS,
  ACCOUNT_ACTIONS,
  REAUTH_TTL_SECONDS,
  issueGrant,
  requireGrant,
  markGrantUsed,
} = require('../lib/reauth');
const { hashPassword, verifyPassword, burnVerify, assertPasswordPolicy } = require('../lib/password');
const { AppError } = require('../lib/errors');
const { logSecurityEvent, EVENTS } = require('../lib/securityEvents');
const { assessCounter, reportCounterAnomaly } = require('../lib/credentialCounter');
const { RP_ID, ORIGIN } = require('../lib/webauthnConfig');

const router = express.Router();

const RP_NAME = 'Escrow Passkeys C2C';
const CHALLENGE_TTL_SECONDS = parseInt(process.env.CHALLENGE_TTL_SECONDS || '300', 10);
const DEMO_BUYER_INITIAL_BALANCE = parseInt(process.env.DEMO_BUYER_INITIAL_BALANCE || '5000000', 10);
const RATE_LIMIT_AUTH_PER_MINUTE = parseInt(process.env.RATE_LIMIT_AUTH_PER_MINUTE || '10', 10);

const authLimiter = rateLimit({ perMinute: RATE_LIMIT_AUTH_PER_MINUTE });

function expiresAtIso() {
  return new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString();
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    accountStatus: row.account_status,
  };
}

function loadUserRow(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function issueSession(row) {
  const scope = scopeForStatus(row.account_status);
  return { token: signAccessToken(row, scope), scope, user: publicUser(row) };
}

// ---------- Bước 1 của đăng ký: tạo tài khoản bằng mật khẩu ----------
//
// Kết quả là một tài khoản ở trạng thái PENDING_PASSKEY: CHƯA có ví và không gọi được bất
// kỳ chức năng nghiệp vụ nào. Vì vậy bước này tự nó không tạo ra một lối vào có ích cho
// bên tấn công.
//
// Bước này KHÔNG nhận bất kỳ tham số nào quyết định quyền. Mọi tài khoản đăng ký thành
// công đều chỉ có năng lực mua. Năng lực bán được cấp về sau qua quy trình xin và duyệt;
// quyền quản trị chỉ được khởi tạo bằng thủ tục vận hành `npm run seed:admin`.

router.post('/register/account', authLimiter, (req, res, next) => {
  try {
    const { username, displayName, password } = req.body || {};
    if (!username || !displayName || !password) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu username, displayName hoặc password');
    }

    const cleanUsername = String(username).trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(cleanUsername)) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Tên đăng nhập dài 3–32 ký tự, chỉ gồm chữ thường, số và . _ -'
      );
    }
    const cleanDisplayName = String(displayName).trim().slice(0, 80);
    if (cleanDisplayName.length < 2) throw new AppError(400, 'VALIDATION_ERROR', 'Tên hiển thị quá ngắn');

    assertPasswordPolicy(password);

    if (db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUsername)) {
      throw new AppError(409, 'USERNAME_TAKEN', 'Tên đăng nhập đã tồn tại');
    }

    const userId = uuid();
    const now = nowIso();
    db.prepare(
      `INSERT INTO users (id, username, display_name, role, password_hash, account_status, token_version, created_at, updated_at)
       VALUES (?, ?, ?, 'BUYER', ?, 'PENDING_PASSKEY', 0, ?, ?)`
    ).run(userId, cleanUsername, cleanDisplayName, hashPassword(password), now, now);

    const session = issueSession(loadUserRow(userId));
    res.status(201).json({
      ...session,
      nextStep: 'REGISTER_PASSKEY',
      message: 'Tài khoản đã được tạo. Hãy đăng ký Passkey để hoàn tất — đây là bước bắt buộc.',
    });
  } catch (e) {
    next(e);
  }
});

// ---------- Bước 2 của đăng ký: đăng ký Passkey bắt buộc ----------
//
// Mức xác minh người dùng đặt là BẮT BUỘC cho credential đầu tiên, và máy chủ chỉ kích hoạt
// tài khoản khi phản hồi hợp lệ VÀ cờ xác minh người dùng được thiết lập. Nhờ vậy credential
// đầu tiên chỉ được ghi nhận sau khi bộ xác thực đã thực hiện xác minh người dùng cục bộ
// thành công.

router.post(
  '/register/passkey/options',
  requireEnrollAuth,
  requireAccountStatus('PENDING_PASSKEY'),
  authLimiter,
  async (req, res, next) => {
    try {
      const user = loadUserRow(req.user.id);

      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: RP_ID,
        userName: user.username,
        userDisplayName: user.display_name,
        attestationType: 'none',
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'required',
        },
      });

      const sessionId = uuid();
      db.prepare(
        `INSERT INTO auth_challenges (id, user_id, transaction_id, challenge, purpose, context_data, expires_at)
         VALUES (?, ?, NULL, ?, 'REGISTRATION', ?, ?)`
      ).run(
        sessionId,
        user.id,
        options.challenge,
        JSON.stringify({ firstCredential: true, deviceName: 'Thiết bị đăng ký' }),
        expiresAtIso()
      );

      res.json({ registrationSessionId: sessionId, options });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  '/register/passkey/verify',
  requireEnrollAuth,
  requireAccountStatus('PENDING_PASSKEY'),
  authLimiter,
  async (req, res, next) => {
    try {
      const { registrationSessionId, response } = req.body || {};
      if (!registrationSessionId || !response) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu registrationSessionId hoặc response');
      }

      const challengeRow = db
        .prepare(`SELECT * FROM auth_challenges WHERE id = ? AND purpose = 'REGISTRATION' AND user_id = ?`)
        .get(registrationSessionId, req.user.id);
      if (!challengeRow) throw new AppError(400, 'CHALLENGE_NOT_FOUND', 'Phiên đăng ký không hợp lệ');
      if (challengeRow.used_at) throw new AppError(400, 'CHALLENGE_REPLAY', 'Challenge đã được sử dụng');
      if (new Date(challengeRow.expires_at).getTime() < Date.now()) {
        throw new AppError(400, 'CHALLENGE_EXPIRED', 'Challenge đã hết hạn');
      }

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response,
          expectedChallenge: challengeRow.challenge,
          expectedOrigin: ORIGIN,
          expectedRPID: RP_ID,
          // Điều kiện kích hoạt tài khoản: bộ xác thực phải báo đã xác minh người dùng.
          requireUserVerification: true,
        });
      } catch (e) {
        throw new AppError(400, 'VERIFICATION_FAILED', e.message);
      }
      if (!verification.verified || !verification.registrationInfo) {
        throw new AppError(400, 'VERIFICATION_FAILED', 'Không xác minh được attestation');
      }

      const { credential } = verification.registrationInfo;
      if (db.prepare('SELECT id FROM passkey_credentials WHERE credential_id = ?').get(credential.id)) {
        throw new AppError(409, 'CREDENTIAL_EXISTS', 'Passkey này đã được đăng ký rồi');
      }

      const user = loadUserRow(req.user.id);
      const { deviceName } = JSON.parse(challengeRow.context_data || '{}');
      const now = nowIso();

      // Ghi credential, mở ví và kích hoạt tài khoản trong CÙNG một giao dịch cơ sở dữ liệu.
      // Đây là chỗ bất biến "tài khoản ACTIVE luôn có ít nhất một Passkey" được tạo ra: không
      // có khoảnh khắc nào tài khoản đã ACTIVE mà chưa có credential.
      db.transaction(() => {
        db.prepare(
          `INSERT INTO passkey_credentials
             (id, user_id, credential_id, public_key, counter, transports, device_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          uuid(),
          user.id,
          credential.id,
          Buffer.from(credential.publicKey),
          credential.counter,
          JSON.stringify(credential.transports || []),
          deviceName || 'Thiết bị đăng ký',
          now
        );

        // Quản trị viên không phải một bên của giao dịch nên không giữ ví.
        if (user.role !== 'ADMIN') {
          const walletId = uuid();
          db.prepare(
            `INSERT INTO wallets (id, user_id, wallet_type, available_balance, locked_balance, version, created_at, updated_at)
             VALUES (?, ?, 'USER', ?, 0, 0, ?, ?)`
          ).run(walletId, user.id, DEMO_BUYER_INITIAL_BALANCE, now, now);

          if (DEMO_BUYER_INITIAL_BALANCE > 0) {
            db.prepare(
              `INSERT INTO wallet_entries
                (id, wallet_id, transaction_id, request_id, entry_type, available_delta, locked_delta,
                 available_after, locked_after, idempotency_key, description, created_at)
               VALUES (?, ?, NULL, ?, 'DEMO_TOPUP', ?, 0, ?, 0, ?, ?, ?)`
            ).run(
              uuid(),
              walletId,
              registrationSessionId,
              DEMO_BUYER_INITIAL_BALANCE,
              DEMO_BUYER_INITIAL_BALANCE,
              `demo-topup:${user.id}`,
              'Số dư demo cấp khi hoàn tất đăng ký',
              now
            );
          }
        }

        db.prepare(`UPDATE users SET account_status = 'ACTIVE', updated_at = ? WHERE id = ?`).run(now, user.id);
        db.prepare(`UPDATE auth_challenges SET used_at = ? WHERE id = ?`).run(now, challengeRow.id);
      })();

      logSecurityEvent(req, {
        type: EVENTS.ACCOUNT_ACTIVATED, outcome: 'ALLOWED', statusCode: 201,
        detail: { accountStatus: 'ACTIVE' },
      });
      res.status(201).json(issueSession(loadUserRow(user.id)));
    } catch (e) {
      next(e);
    }
  }
);

// ---------- Đăng nhập bằng mật khẩu ----------
//
// Sai tên đăng nhập và sai mật khẩu trả về CÙNG một thông báo, để điểm cuối này không trở
// thành công cụ dò xem tên đăng nhập nào đang tồn tại. Khi tên đăng nhập không tồn tại,
// máy chủ vẫn chạy một lần dẫn xuất giả để thời gian phản hồi không tự tố cáo điều đó.
//
// Đăng nhập thành công chỉ cấp một PHIÊN. Nó không cấp phiếu uỷ quyền, nên không đưa được
// tiền ra khỏi ký quỹ, không thêm được credential và không đổi được chính mật khẩu đó.

router.post('/login/password', authLimiter, (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu username hoặc password');

    const cleanUsername = String(username).trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(cleanUsername);

    const INVALID = new AppError(401, 'INVALID_CREDENTIALS', 'Tên đăng nhập hoặc mật khẩu không đúng');

    if (!user) {
      burnVerify(password);
      throw INVALID;
    }
    if (!verifyPassword(password, user.password_hash)) throw INVALID;
    if (!user.is_active) throw new AppError(401, 'USER_INACTIVE', 'Tài khoản không khả dụng');

    const session = issueSession(user);
    res.json({
      ...session,
      nextStep:
        user.account_status === 'PENDING_BOOTSTRAP'
          ? 'CHANGE_TEMPORARY_PASSWORD'
          : user.account_status === 'PENDING_PASSKEY'
            ? 'REGISTER_PASSKEY'
            : null,
    });
  } catch (e) {
    next(e);
  }
});

// ---------- Đăng nhập bằng Passkey ----------
//
// Tuỳ chọn xác thực KHÔNG kèm danh sách credential: bộ xác thực tự liệt kê các Passkey đã
// đăng ký cho RP ID đang truy cập, nên máy chủ không phải tiết lộ tài khoản nào có Passkey
// trước khi người dùng chứng minh được quyền sở hữu.
//
// Mức xác minh người dùng ở đây là ƯU TIÊN chứ không bắt buộc, vì mục tiêu của bước đăng
// nhập chỉ là mở một phiên. Mức bắt buộc được dành cho bước xác thực lại, nơi kết quả xác
// thực được dùng để cho phép tiền rời khỏi ký quỹ.

router.post('/login/options', authLimiter, async (req, res, next) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'preferred',
    });

    const sessionId = uuid();
    db.prepare(
      `INSERT INTO auth_challenges (id, user_id, transaction_id, challenge, purpose, context_data, expires_at)
       VALUES (?, NULL, NULL, ?, 'AUTHENTICATION', '{}', ?)`
    ).run(sessionId, options.challenge, expiresAtIso());

    res.json({ authenticationSessionId: sessionId, options });
  } catch (e) {
    next(e);
  }
});

router.post('/login/verify', authLimiter, async (req, res, next) => {
  try {
    const { authenticationSessionId, response } = req.body || {};
    if (!authenticationSessionId || !response) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu authenticationSessionId hoặc response');
    }

    const challengeRow = db
      .prepare(`SELECT * FROM auth_challenges WHERE id = ? AND purpose = 'AUTHENTICATION'`)
      .get(authenticationSessionId);
    if (!challengeRow) throw new AppError(400, 'CHALLENGE_NOT_FOUND', 'Phiên đăng nhập không hợp lệ');
    if (challengeRow.used_at) throw new AppError(400, 'CHALLENGE_REPLAY', 'Challenge đã được sử dụng');
    if (new Date(challengeRow.expires_at).getTime() < Date.now()) {
      throw new AppError(400, 'CHALLENGE_EXPIRED', 'Challenge đã hết hạn');
    }

    const credentialRow = db.prepare('SELECT * FROM passkey_credentials WHERE credential_id = ?').get(response.id);
    if (!credentialRow) throw new AppError(401, 'CREDENTIAL_NOT_FOUND', 'Không tìm thấy Passkey tương ứng');

    const user = loadUserRow(credentialRow.user_id);
    if (!user || !user.is_active) throw new AppError(401, 'USER_INACTIVE', 'Tài khoản không khả dụng');

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: {
          id: credentialRow.credential_id,
          publicKey: credentialRow.public_key,
          // 0: không để thư viện từ chối cứng khi counter không tăng — counter được đánh giá
          // như tín hiệu rủi ro ở lib/credentialCounter.js.
          counter: 0,
          transports: JSON.parse(credentialRow.transports || '[]'),
        },
      });
    } catch (e) {
      throw new AppError(400, 'VERIFICATION_FAILED', e.message);
    }
    if (!verification.verified) throw new AppError(401, 'VERIFICATION_FAILED', 'Xác thực Passkey thất bại');

    const counterCheck = assessCounter(credentialRow, verification.authenticationInfo.newCounter);
    const now = nowIso();
    db.transaction(() => {
      db.prepare('UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE id = ?').run(
        counterCheck.stored,
        now,
        credentialRow.id
      );
      db.prepare(`UPDATE auth_challenges SET used_at = ? WHERE id = ?`).run(now, challengeRow.id);
    })();
    reportCounterAnomaly(req, credentialRow, counterCheck);

    // Hai lối đăng nhập cấp CÙNG một loại phiên. Phiên tạo bằng Passkey cũng không được coi
    // là đủ để giải ngân — quyền đó chỉ đến từ phiếu uỷ quyền của một lần xác thực lại.
    res.json(issueSession(loadUserRow(user.id)));
  } catch (e) {
    next(e);
  }
});

// ---------- Ngoại lệ khởi tạo: đổi mật khẩu tạm của quản trị viên ----------
//
// Quy tắc chung đòi một credential đang có để đổi mật khẩu. Tài khoản quản trị viên đầu
// tiên được tạo bằng thủ tục vận hành trên máy chủ và tại thời điểm đó chưa có credential
// nào, nên nếu để nguyên thì quy tắc sẽ tự chặn chính bước thiết lập quản trị viên.
//
// Ngoại lệ này chỉ mở cho đúng trạng thái PENDING_BOOTSTRAP, đòi đúng mật khẩu tạm, và chỉ
// đưa tài khoản sang PENDING_PASSKEY — tức là vẫn chưa dùng được chức năng nào. Sau khi
// đăng ký Passkey đầu tiên, mọi lần đổi mật khẩu về sau đều theo quy tắc chung.

router.post(
  '/bootstrap/password',
  requireEnrollAuth,
  requireAccountStatus('PENDING_BOOTSTRAP'),
  authLimiter,
  (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body || {};
      if (!currentPassword || !newPassword) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu currentPassword hoặc newPassword');
      }

      const user = loadUserRow(req.user.id);
      if (!verifyPassword(currentPassword, user.password_hash)) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Mật khẩu tạm không đúng');
      }
      assertPasswordPolicy(newPassword);
      if (verifyPassword(newPassword, user.password_hash)) {
        throw new AppError(400, 'SAME_PASSWORD', 'Mật khẩu mới phải khác mật khẩu tạm');
      }

      const now = nowIso();
      db.prepare(
        `UPDATE users
         SET password_hash = ?, account_status = 'PENDING_PASSKEY', token_version = token_version + 1, updated_at = ?
         WHERE id = ?`
      ).run(hashPassword(newPassword), now, user.id);

      logSecurityEvent(req, {
        type: EVENTS.ADMIN_BOOTSTRAP_PASSWORD_CHANGED, outcome: 'ALLOWED', statusCode: 200,
        detail: { accountStatus: 'PENDING_PASSKEY' },
      });

      // token_version vừa tăng nên mã phiên hiện tại đã hết hiệu lực; cấp lại mã mới.
      res.json({
        ...issueSession(loadUserRow(user.id)),
        nextStep: 'REGISTER_PASSKEY',
        message: 'Đã đổi mật khẩu tạm. Hãy đăng ký Passkey đầu tiên để kích hoạt quyền quản trị.',
      });
    } catch (e) {
      next(e);
    }
  }
);

// ---------- Xác thực lại cho các thao tác trên tài khoản ----------
//
// Dùng chung cơ chế phiếu uỷ quyền với luồng giải ngân, chỉ khác hành động được uỷ quyền
// và không gắn với giao dịch nào. Hai hành động đi qua đây: quản lý credential và đổi mật
// khẩu. Challenge phát cho hành động này không đem dùng cho hành động khác được, vì mục
// đích được lưu trong bản ghi challenge ở phía máy chủ.

function parseAccountAction(raw) {
  const action = String(raw || ACTIONS.MANAGE_CREDENTIAL).toUpperCase();
  if (!ACCOUNT_ACTIONS.has(action)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'action phải là MANAGE_CREDENTIAL hoặc CHANGE_PASSWORD');
  }
  return action;
}

router.post('/reauth/options', requireAuth, authLimiter, async (req, res, next) => {
  try {
    const action = parseAccountAction((req.body || {}).action);

    const credentials = db.prepare('SELECT * FROM passkey_credentials WHERE user_id = ?').all(req.user.id);
    if (credentials.length === 0) throw new AppError(400, 'NO_CREDENTIAL', 'Tài khoản chưa có Passkey');

    // Không truyền challenge: thư viện tự sinh giá trị ngẫu nhiên bằng nguồn ngẫu nhiên
    // mật mã. Thao tác nhạy cảm đòi mức xác minh người dùng bắt buộc.
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'required',
      allowCredentials: credentials.map((c) => ({
        id: c.credential_id,
        transports: JSON.parse(c.transports || '[]'),
      })),
    });

    const sessionId = uuid();
    const expiresAt = new Date(Date.now() + REAUTH_TTL_SECONDS * 1000).toISOString();
    db.prepare(
      `INSERT INTO auth_challenges (id, user_id, transaction_id, challenge, purpose, context_data, expires_at)
       VALUES (?, ?, NULL, ?, 'REAUTH', ?, ?)`
    ).run(sessionId, req.user.id, options.challenge, JSON.stringify({ action }), expiresAt);

    res.json({ reauthSessionId: sessionId, options, action });
  } catch (e) {
    next(e);
  }
});

router.post('/reauth/verify', requireAuth, authLimiter, async (req, res, next) => {
  try {
    const { reauthSessionId, response } = req.body || {};
    if (!reauthSessionId || !response) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu reauthSessionId hoặc response');
    }

    const challengeRow = db
      .prepare(`SELECT * FROM auth_challenges WHERE id = ? AND purpose = 'REAUTH' AND user_id = ?`)
      .get(reauthSessionId, req.user.id);
    if (!challengeRow) throw new AppError(400, 'CHALLENGE_NOT_FOUND', 'Phiên xác thực lại không hợp lệ');
    if (challengeRow.used_at) throw new AppError(400, 'CHALLENGE_REPLAY', 'Challenge đã dùng');
    if (new Date(challengeRow.expires_at).getTime() < Date.now()) {
      throw new AppError(400, 'CHALLENGE_EXPIRED', 'Challenge đã hết hạn');
    }

    // Mục đích đọc lại từ bản ghi phía máy chủ, không nhận lại từ người gọi.
    const savedContext = JSON.parse(challengeRow.context_data || '{}');
    if (!ACCOUNT_ACTIONS.has(savedContext.action)) {
      throw new AppError(400, 'CHALLENGE_PURPOSE_MISMATCH', 'Challenge không dành cho thao tác này');
    }

    const credential = db
      .prepare('SELECT * FROM passkey_credentials WHERE user_id = ? AND credential_id = ?')
      .get(req.user.id, response.id);
    if (!credential) throw new AppError(400, 'NO_CREDENTIAL', 'Passkey này không thuộc tài khoản của bạn');

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true,
        credential: {
          id: credential.credential_id,
          publicKey: credential.public_key,
          counter: 0, // counter là tín hiệu rủi ro, xem lib/credentialCounter.js
          transports: JSON.parse(credential.transports || '[]'),
        },
      });
    } catch (e) {
      throw new AppError(400, 'VERIFICATION_FAILED', e.message);
    }
    if (!verification.verified) throw new AppError(401, 'VERIFICATION_FAILED', 'Xác thực lại thất bại');

    const counterCheck = assessCounter(credential, verification.authenticationInfo.newCounter);
    let issued;
    db.transaction(() => {
      db.prepare('UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE id = ?').run(
        counterCheck.stored,
        nowIso(),
        credential.id
      );
      db.prepare('UPDATE auth_challenges SET used_at = ? WHERE id = ?').run(nowIso(), challengeRow.id);
      issued = issueGrant({
        userId: req.user.id,
        transactionId: null,
        disputeId: null,
        action: savedContext.action,
        decision: null,
        contextHash: null,
      });
    })();
    reportCounterAnomaly(req, credential, counterCheck);

    res.json({ reauthGrant: issued.rawToken, expiresAt: issued.expiresAt, action: savedContext.action });
  } catch (e) {
    next(e);
  }
});

// ---------- Quản lý thiết bị (nhiều passkey cho một tài khoản) ----------
//
// Cho phép nhiều credential để giảm nguy cơ mất khả năng thực hiện các thao tác bắt buộc
// Passkey khi một credential không còn dùng được. Trong mô hình lai, người dùng mất toàn
// bộ credential vẫn đăng nhập được bằng mật khẩu, nhưng không tự thực hiện được các thao
// tác yêu cầu xác thực lại — nên mật khẩu KHÔNG phải một kênh khôi phục Passkey.

function listCredentials(userId) {
  return db
    .prepare(
      `SELECT id, device_name, created_at, last_used_at FROM passkey_credentials
       WHERE user_id = ? ORDER BY created_at ASC`
    )
    .all(userId)
    .map((c) => ({
      id: c.id,
      deviceName: c.device_name || 'Thiết bị không tên',
      createdAt: c.created_at,
      lastUsedAt: c.last_used_at,
    }));
}

router.get('/credentials', requireAuth, (req, res) => {
  res.json({ credentials: listCredentials(req.user.id) });
});

// Thêm thiết bị mới. Người gọi PHẢI vừa xác thực lại bằng một credential sẵn có, nghĩa
// là chỉ ai đang cầm thiết bị cũ mới thêm được thiết bị mới; một mã phiên bị đánh cắp
// không đủ. excludeCredentials chặn việc đăng ký trùng đúng cái passkey đang dùng.
//
// Phiếu được kiểm ở đây để người dùng biết sớm, nhưng chỉ bị TIÊU THỤ ở bước verify —
// bước thực sự ghi credential mới vào cơ sở dữ liệu.
router.post('/credentials/options', requireAuth, authLimiter, async (req, res, next) => {
  try {
    requireGrant({
      userId: req.user.id,
      action: ACTIONS.MANAGE_CREDENTIAL,
      rawToken: (req.body || {}).reauthGrant,
      message: 'Thêm thiết bị cần xác thực lại bằng passkey đang có',
    });

    const user = loadUserRow(req.user.id);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Không tìm thấy tài khoản');

    const existing = db.prepare('SELECT credential_id, transports FROM passkey_credentials WHERE user_id = ?').all(user.id);

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: user.username,
      userDisplayName: user.display_name,
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.credential_id,
        transports: JSON.parse(c.transports || '[]'),
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });

    const deviceName = String(req.body?.deviceName || '').trim().slice(0, 60) || 'Thiết bị mới';
    const sessionId = uuid();
    db.prepare(
      `INSERT INTO auth_challenges (id, user_id, transaction_id, challenge, purpose, context_data, expires_at)
       VALUES (?, ?, NULL, ?, 'REGISTRATION', ?, ?)`
    ).run(sessionId, user.id, options.challenge, JSON.stringify({ addDevice: true, deviceName }), expiresAtIso());

    res.json({ registrationSessionId: sessionId, options });
  } catch (e) {
    next(e);
  }
});

router.post('/credentials/verify', requireAuth, authLimiter, async (req, res, next) => {
  try {
    const { registrationSessionId, response, reauthGrant } = req.body || {};
    if (!registrationSessionId || !response) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu registrationSessionId hoặc response');
    }

    const grant = requireGrant({
      userId: req.user.id,
      action: ACTIONS.MANAGE_CREDENTIAL,
      rawToken: reauthGrant,
      message: 'Thêm thiết bị cần xác thực lại bằng passkey đang có',
    });

    // Challenge phải thuộc đúng người đang đăng nhập — chặn việc mượn phiên của người khác.
    const challengeRow = db
      .prepare(`SELECT * FROM auth_challenges WHERE id = ? AND purpose = 'REGISTRATION' AND user_id = ?`)
      .get(registrationSessionId, req.user.id);
    if (!challengeRow) throw new AppError(400, 'CHALLENGE_NOT_FOUND', 'Phiên thêm thiết bị không hợp lệ');
    if (challengeRow.used_at) throw new AppError(400, 'CHALLENGE_REPLAY', 'Challenge đã được sử dụng');
    if (new Date(challengeRow.expires_at).getTime() < Date.now()) {
      throw new AppError(400, 'CHALLENGE_EXPIRED', 'Challenge đã hết hạn');
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true,
      });
    } catch (e) {
      throw new AppError(400, 'VERIFICATION_FAILED', e.message);
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new AppError(400, 'VERIFICATION_FAILED', 'Không xác minh được attestation');
    }

    const { credential } = verification.registrationInfo;
    const { deviceName } = JSON.parse(challengeRow.context_data || '{}');
    const now = nowIso();

    if (db.prepare('SELECT id FROM passkey_credentials WHERE credential_id = ?').get(credential.id)) {
      throw new AppError(409, 'CREDENTIAL_EXISTS', 'Passkey này đã được đăng ký rồi');
    }

    db.transaction(() => {
      db.prepare(
        `INSERT INTO passkey_credentials
           (id, user_id, credential_id, public_key, counter, transports, device_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        uuid(),
        req.user.id,
        credential.id,
        Buffer.from(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports || []),
        deviceName || 'Thiết bị mới',
        now
      );
      db.prepare(`UPDATE auth_challenges SET used_at = ? WHERE id = ?`).run(now, challengeRow.id);
      // Tiêu thụ phiếu trong CÙNG giao dịch cơ sở dữ liệu với việc ghi credential, nên
      // không có khoảnh khắc nào phiếu vừa còn hiệu lực vừa đã được dùng.
      markGrantUsed(grant.id);
    })();

    logSecurityEvent(req, {
      type: EVENTS.CREDENTIAL_ADDED, outcome: 'ALLOWED', statusCode: 201,
      detail: { deviceName: deviceName || 'Thiết bị mới' },
    });
    res.status(201).json({ credentials: listCredentials(req.user.id) });
  } catch (e) {
    next(e);
  }
});

// Xoá thiết bị. Cũng đòi xác thực lại, vì xoá credential của người khác rồi thêm của
// mình là một cách chiếm tài khoản không kém việc thêm thẳng.
//
// Không cho xoá cái CUỐI CÙNG. Đây là một nửa của bất biến "tài khoản ACTIVE luôn có ít
// nhất một Passkey"; nửa còn lại là việc chỉ kích hoạt tài khoản khi credential đầu tiên
// đã được ghi.
router.delete('/credentials/:id', requireAuth, (req, res, next) => {
  try {
    const grant = requireGrant({
      userId: req.user.id,
      action: ACTIONS.MANAGE_CREDENTIAL,
      rawToken: (req.body || {}).reauthGrant,
      message: 'Xoá thiết bị cần xác thực lại bằng passkey đang có',
    });

    const target = db
      .prepare('SELECT * FROM passkey_credentials WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!target) throw new AppError(404, 'CREDENTIAL_NOT_FOUND', 'Không tìm thấy thiết bị');

    const total = db.prepare('SELECT COUNT(*) AS n FROM passkey_credentials WHERE user_id = ?').get(req.user.id).n;
    if (total <= 1) {
      throw new AppError(
        409,
        'LAST_CREDENTIAL',
        'Đây là passkey duy nhất của bạn. Hãy thêm thiết bị khác trước khi xoá cái này.'
      );
    }

    db.transaction(() => {
      db.prepare('DELETE FROM passkey_credentials WHERE id = ?').run(target.id);
      markGrantUsed(grant.id);
    })();

    logSecurityEvent(req, {
      type: EVENTS.CREDENTIAL_REMOVED, outcome: 'ALLOWED', statusCode: 200,
      detail: { credentialId: target.id, deviceName: target.device_name },
    });
    res.json({ credentials: listCredentials(req.user.id) });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
