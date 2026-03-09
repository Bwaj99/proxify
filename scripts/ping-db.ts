/**
 * Quick DB connection test. Run: npx ts-node scripts/ping-db.ts
 * Uses the same .env as the app.
 */
import "dotenv/config";
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set in .env");
  process.exit(1);
}

// Hide password in log
const safeUrl = url.replace(/:([^:@]+)@/, ":****@");
console.log("Connecting to", safeUrl, "...");

const pool = new Pool({ connectionString: url });
pool
  .query("SELECT 1 as ok")
  .then((res) => {
    console.log("OK — connected. Result:", res.rows[0]);
    pool.end();
    process.exit(0);
  })
  .catch((err: Error) => {
    console.error("Connection failed:", err.message);
    pool.end();
    process.exit(1);
  });


  