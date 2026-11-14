
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/database");

const router = express.Router();

function createToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

// REGISTER
router.post("/register", async (req, res) => {
  const { full_name, email, phone, password } = req.body;

  if (!full_name || !email || !password) {
    return res.status(400).json({
      success: false,
      message: "Full name, email and password are required."
    });
  }

  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({
      success: false,
      message: "Password must contain at least 8 characters."
    });
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid email address."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await client.query(
      "SELECT id FROM users WHERE LOWER(email) = $1",
      [normalizedEmail]
    );

    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Email is already registered."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await client.query(
      `INSERT INTO users
       (full_name, email, phone, password_hash, role, status)
       VALUES ($1, $2, $3, $4, 'CUSTOMER', 'ACTIVE')
       RETURNING id, full_name, email, phone, role, status, created_at`,
      [
        String(full_name).trim(),
        normalizedEmail,
        phone ? String(phone).trim() : null,
        passwordHash
      ]
    );

    const user = result.rows[0];

    await client.query(
      `INSERT INTO wallets (user_id, balance_kobo, currency)
       VALUES ($1, 0, 'NGN')`,
      [user.id]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Account created successfully.",
      token: createToken(user),
      user
    });
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Email or phone number is already registered."
      });
    }

    console.error("Registration error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to create account."
    });
  } finally {
    client.release();
  }
});

// LOGIN
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password || typeof password !== "string") {
    return res.status(400).json({
      success: false,
      message: "Email and password are required."
    });
  }

  try {
    const result = await pool.query(
      `SELECT id, full_name, email, phone, password_hash, role, status
       FROM users WHERE LOWER(email) = $1`,
      [String(email).trim().toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password."
      });
    }

    const user = result.rows[0];

    if (user.status !== "ACTIVE") {
      return res.status(403).json({
        success: false,
        message: "This account is not active."
      });
    }

    const validPassword = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password."
      });
    }

    const token = createToken(user);
    delete user.password_hash;

    return res.json({
      success: true,
      message: "Login successful.",
      token,
      user
    });
  } catch (error) {
    console.error("Login error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to login."
    });
  }
});

module.exports = router;
