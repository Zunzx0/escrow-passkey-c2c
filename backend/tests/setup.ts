// Loaded by vitest BEFORE any test file (and therefore before src/config/env.ts
// is ever imported), so it must override DATABASE_URL etc. to point at the
// separate automated-test database (kiến thức §62: "Test environment phải
// tách") rather than the dev database.
import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(__dirname, "../.env.test"), override: true });
