
const fs = require("fs");
const path = require("path");
const pool = require("../config/database");

async function migrate() {
  const schemaPath = path.join(__dirname, "../../database/schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");

  await pool.query(sql);

  console.log("SAHRAB DATA SUB database migration successful.");
}

module.exports = migrate;
