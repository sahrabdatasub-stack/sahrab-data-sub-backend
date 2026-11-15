
const express = require("express");
const crypto = require("crypto");
const pool = require("../config/database");
const authenticateToken = require("../middleware/auth");

const router = express.Router();

// INITIALIZE PAYSTACK WALLET FUNDING
router.post("/paystack/initialize", authenticateToken, async (req, res) => {
  const amountNaira = Number(req.body.amount_naira);

  if (
    !Number.isFinite(amountNaira) ||
    amountNaira <= 0 ||
    !Number.isSafeInteger(Math.round(amountNaira * 100))
  ) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid deposit amount."
    });
  }

  if (!process.env.PAYSTACK_SECRET_KEY) {
    return res.status(503).json({
      success: false,
      message: "Payment provider is not configured."
    });
  }

  const amountKobo = Math.round(amountNaira * 100);
  const reference = `SHR-${crypto.randomUUID()}`;

  try {
    await pool.query(
      `INSERT INTO transactions
       (user_id, reference, type, amount_kobo, status, provider, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user.id,
        reference,
        "WALLET_FUNDING",
        amountKobo,
        "PENDING",
        "PAYSTACK",
        "Wallet funding"
      ]
    );

    const payload = {
      email: req.user.email,
      amount: amountKobo,
      reference,
      metadata: {
        user_id: req.user.id,
        purpose: "wallet_funding"
      }
    };

    if (process.env.PAYSTACK_CALLBACK_URL) {
      payload.callback_url = process.env.PAYSTACK_CALLBACK_URL;
    }

    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const result = await response.json();

    if (!response.ok || !result.status || !result.data?.authorization_url) {
      await pool.query(
        `UPDATE transactions
         SET status = 'FAILED', updated_at = NOW()
         WHERE reference = $1 AND user_id = $2`,
        [reference, req.user.id]
      );

      return res.status(502).json({
        success: false,
        message: "Unable to initialize payment."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Payment initialized successfully.",
      reference,
      authorization_url: result.data.authorization_url,
      access_code: result.data.access_code
    });
  } catch (error) {
    console.error("Payment initialization error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Payment initialization failed."
    });
  }
});

module.exports = router;
