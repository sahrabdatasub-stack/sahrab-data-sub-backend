
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const app = express();
const PORT = process.env.PORT || 3000;

const pool = process.env.DATABASE_URL
  ? require("./config/database")
  : null;

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.json({
    name: "SAHRAB DATA SUB",
    company: "SAHRAB BUSINESS",
    message: "Backend API is running",
    version: "1.0.0"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/ready", async (req, res) => {
  if (!pool) {
    return res.status(503).json({
      status: "not_ready",
      database: "not_configured"
    });
  }

  try {
    await pool.query("SELECT 1");
    return res.json({
      status: "ready",
      database: "connected"
    });
  } catch (error) {
    return res.status(503).json({
      status: "not_ready",
      database: "disconnected"
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API route not found"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SAHRAB DATA SUB API running on port ${PORT}`);
});
