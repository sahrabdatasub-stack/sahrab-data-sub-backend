
const express = require("express");
const pool = require("../config/database");
const authenticateToken = require("../middleware/auth");

const router = express.Router();

// GET AUTHENTICATED USER TRANSACTION HISTORY
router.get("/", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, reference, type, amount_kobo, status,
              provider, description, created_at
       FROM transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.id]
    );

    return res.json({
      success: true,
      count: result.rows.length,
      transactions: result.rows.map((tx) => ({
        ...tx,
        amount_kobo: Number(tx.amount_kobo),
        amount_naira: Number(tx.amount_kobo) / 100
    console.error("Transaction history error:", error.message);
      }))
    });
  } catch (error) {

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve transaction history."
    });
  }
});

module.exports = router;
