class AppError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

class ConflictError extends AppError {
  constructor(code = 'VERSION_CONFLICT', message = 'Dữ liệu đã thay đổi, vui lòng thử lại') {
    super(409, code, message);
  }
}

module.exports = { AppError, ConflictError };
