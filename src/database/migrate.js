
const fs = require("fs");
const path = require("path");
const pool = require("../config/database");

async function migrate() {
  try {
    const schemaPath = path.join(__dirname, "../../database/schema.sql");
    const sql = fs.readFileSync(schemaPath, "utf8");

    await pool.query(sql);

    console.log("SAHRAB DATA SUB database migration successful.");
  } catch (error) {
    console.error("Database migration failed:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();
