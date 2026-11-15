
const express = require("express");
const pool = require("../config/database");
const authenticateToken = require("../middleware/auth");

const router = express.Router();

// GET AUTHENTICATED USER WALLET
router.get("/", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, balance_kobo, currency, created_at, updated_at
       FROM wallets
       WHERE user_id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found."
      });
    }

    const wallet = result.rows[0];

    return res.json({
      success: true,
      wallet: {
        id: wallet.id,
        balance_kobo: Number(wallet.balance_kobo),
        balance_naira: Number(wallet.balance_kobo) / 100,
        currency: wallet.currency,
        created_at: wallet.created_at,
        updated_at: wallet.updated_at
      }
    });
  } catch (error) {
    console.error("Wallet fetch error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve wallet."
    });
  }
});

module.exports = router;
