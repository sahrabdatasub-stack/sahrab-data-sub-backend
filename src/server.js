
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const pool = require("./config/database");
const migrate = require("./database/migrate");

const app = express();
const PORT = process.env.PORT || 3000;

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
  try {
    await pool.query("SELECT 1");
    res.json({
      status: "ready",
      database: "connected"
    });
  } catch (error) {
    res.status(503).json({
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

async function startServer() {
  try {
    await migrate();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`SAHRAB DATA SUB API running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Backend startup failed:", error.message);
    process.exit(1);
  }
}

startServer();
