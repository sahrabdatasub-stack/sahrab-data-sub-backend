
const express = require("express");
const crypto = require("crypto");
const pool = require("../config/database");
const authenticateToken = require("../middleware/auth");

const router = express.Router();

const PAYSTACK_BASE_URL = "https://api.paystack.co";

// DEPOSIT SERVICE CHARGE: 1%
const DEPOSIT_FEE_PERCENT = Number(
  process.env.DEPOSIT_SERVICE_CHARGE_PERCENT || 1
);

function getPaystackSecret() {
  return process.env.PAYSTACK_SECRET_KEY;
}

function generateReference() {
  return `SHR-${crypto.randomUUID()}`;
}

// Convert Naira to Kobo safely.
function nairaToKobo(value) {
  const amount = String(value ?? "").trim();

  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) {
    return null;
  }

  const [whole, fraction = ""] = amount.split(".");
  const result =
    Number(whole) * 100 +
    Number(fraction.padEnd(2, "0"));

  return Number.isSafeInteger(result) && result > 0
    ? result
    : null;
}

function getDepositBreakdown(grossKobo) {
  const feeKobo = Math.round(
    grossKobo * DEPOSIT_FEE_PERCENT / 100
  );

  return {
    grossKobo,
    feeKobo,
    netKobo: grossKobo - feeKobo
  };
}

// PAYSTACK API REQUEST
async function paystackRequest(path) {
  const secret = getPaystackSecret();

  if (!secret) {
    throw new Error("PAYSTACK_NOT_CONFIGURED");
  }

  const response = await fetch(
    `${PAYSTACK_BASE_URL}${path}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secret}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(20000)
    }
  );

  let result = {};

  try {
    result = await response.json();
  } catch {
    throw new Error("INVALID_PAYSTACK_RESPONSE");
  }

  return {
    httpStatus: response.status,
    result
  };
}

// MARK PAYMENT FAILED ONLY WHEN PROVIDER CONFIRMS FAILURE
async function markPaymentFailed(reference, providerReference) {
  await pool.query(
    `UPDATE transactions
     SET status = 'FAILED',
         provider_reference = COALESCE($2, provider_reference),
         updated_at = NOW(),
         metadata = metadata || $3::jsonb
     WHERE reference = $1
       AND type = 'WALLET_FUNDING'
       AND provider = 'PAYSTACK'
       AND status = 'PENDING'`,
    [
      reference,
      providerReference || null,
      JSON.stringify({
        provider_confirmed_failed: true,
        checked_at: new Date().toISOString()
      })
    ]
  );
}

// PROCESS A VERIFIED SUCCESSFUL PAYMENT
async function creditVerifiedPayment(reference, payment) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const transactionResult = await client.query(
      `SELECT *
       FROM transactions
       WHERE reference = $1
         AND type = 'WALLET_FUNDING'
         AND provider = 'PAYSTACK'
       FOR UPDATE`,
      [reference]
    );

    if (transactionResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return {
        processed: false,
        status: "NOT_FOUND"
      };
    }

    const transaction = transactionResult.rows[0];

    // Never credit an already processed transaction.
    if (transaction.status === "SUCCESSFUL") {
      await client.query("COMMIT");

      return {
        processed: true,
        duplicate: true,
        status: "SUCCESSFUL"
      };
    }

    if (transaction.status !== "PENDING") {
      await client.query("COMMIT");

      return {
        processed: false,
        status: transaction.status
      };
    }

    const metadata = transaction.metadata || {};

    const grossKobo = Number(
      metadata.deposit_gross_kobo || transaction.amount_kobo
    );

    const feeKobo = Number(metadata.deposit_fee_kobo);
    const netKobo = Number(metadata.wallet_credit_kobo);

    if (
      !Number.isSafeInteger(grossKobo) ||
      !Number.isSafeInteger(feeKobo) ||
      !Number.isSafeInteger(netKobo) ||
      grossKobo <= 0 ||
      feeKobo < 0 ||
      netKobo <= 0 ||
      grossKobo !== feeKobo + netKobo
    ) {
      throw new Error("INVALID_DEPOSIT_METADATA");
    }

    // Verify the actual amount paid.
    if (
      Number(payment.amount) !== grossKobo ||
      payment.currency !== "NGN"
    ) {
      throw new Error("PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH");
    }

    // Verify customer identity when provider metadata is present.
    if (
      payment.metadata?.user_id &&
      String(payment.metadata.user_id) !== String(transaction.user_id)
    ) {
      throw new Error("PAYMENT_USER_MISMATCH");
    }

    // Lock the customer's existing wallet.
    const walletResult = await client.query(
      `SELECT id
       FROM wallets
       WHERE user_id = $1
       FOR UPDATE`,
      [transaction.user_id]
    );

    if (walletResult.rows.length === 0) {
      throw new Error("CUSTOMER_WALLET_NOT_FOUND");
    }

    const walletId = walletResult.rows[0].id;

    // Credit only the net deposit amount.
    await client.query(
      `UPDATE wallets
       SET balance_kobo = balance_kobo + $1,
           updated_at = NOW()
       WHERE id = $2`,
      [netKobo, walletId]
    );

    // Balanced double-entry deposit ledger.
    if (feeKobo > 0) {
      await client.query(
        `INSERT INTO ledger_entries
         (transaction_id, account_code, entry_type, amount_kobo)
         VALUES
         ($1, 'PAYSTACK_CLEARING', 'DEBIT', $2),
         ($1, 'CUSTOMER_WALLET_LIABILITY', 'CREDIT', $3),
         ($1, 'DEPOSIT_SERVICE_REVENUE', 'CREDIT', $4)`,
        [
          transaction.id,
          grossKobo,
          netKobo,
          feeKobo
        ]
      );
    } else {
      await client.query(
        `INSERT INTO ledger_entries
         (transaction_id, account_code, entry_type, amount_kobo)
         VALUES
         ($1, 'PAYSTACK_CLEARING', 'DEBIT', $2),
         ($1, 'CUSTOMER_WALLET_LIABILITY', 'CREDIT', $2)`,
        [transaction.id, grossKobo]
      );
    }

    // Mark successful in the same database transaction.
    await client.query(
      `UPDATE transactions
       SET status = 'SUCCESSFUL',
           provider_reference = $2,
           updated_at = NOW(),
           metadata = metadata || $3::jsonb
       WHERE id = $1
         AND status = 'PENDING'`,
      [
        transaction.id,
        String(payment.id || ""),
        JSON.stringify({
          provider_verified: true,
          provider_status: payment.status,
          deposit_gross_kobo: grossKobo,
          deposit_fee_kobo: feeKobo,
          wallet_credit_kobo: netKobo,
          verified_at: new Date().toISOString()
        })
      ]
    );

    await client.query("COMMIT");

    return {
      processed: true,
      duplicate: false,
      status: "SUCCESSFUL",
      grossKobo,
      feeKobo,
      netKobo
    };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// VERIFY PAYMENT DIRECTLY WITH PAYSTACK
async function verifyPayment(reference) {
  const result = await paystackRequest(
    `/transaction/verify/${encodeURIComponent(reference)}`
  );

  if (
    !result.httpStatus ||
    !result.result.status ||
    !result.result.data
  ) {
    throw new Error("PAYSTACK_VERIFICATION_FAILED");
  }

  const payment = result.result.data;

  if (payment.status === "success") {
    return creditVerifiedPayment(reference, payment);
  }

  if (payment.status === "failed") {
    await markPaymentFailed(reference, payment.id);

    return {
      processed: false,
      status: "FAILED"
    };
  }

  return {
    processed: false,
    status: "PENDING"
  };
}

// INITIALIZE WALLET FUNDING
router.post("/paystack/initialize", authenticateToken, async (req, res) => {
  try {
    if (!getPaystackSecret()) {
      return res.status(503).json({
        success: false,
        message: "Payment provider is not configured."
      });
    }

    if (
      !Number.isFinite(DEPOSIT_FEE_PERCENT) ||
      DEPOSIT_FEE_PERCENT < 0 ||
      DEPOSIT_FEE_PERCENT >= 100
    ) {
      return res.status(503).json({
        success: false,
        message: "Deposit charge configuration is invalid."
      });
    }

    const amountKobo = nairaToKobo(req.body.amount_naira);

    if (!amountKobo) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid deposit amount."
      });
    }

    const breakdown = getDepositBreakdown(amountKobo);

    if (breakdown.netKobo <= 0) {
      return res.status(400).json({
        success: false,
        message: "Deposit amount is too small."
      });
    }

    const idempotencyKey = String(
      req.headers["idempotency-key"] || ""
    ).trim();

    if (
      idempotencyKey &&
      (idempotencyKey.length < 8 || idempotencyKey.length > 120)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid Idempotency-Key."
      });
    }

    // Return an existing request instead of creating another payment.
    if (idempotencyKey) {
      const existingResult = await pool.query(
        `SELECT reference, status, amount_kobo, metadata
         FROM transactions
         WHERE user_id = $1
           AND idempotency_key = $2
           AND type = 'WALLET_FUNDING'`,
        [req.user.id, idempotencyKey]
      );

      if (existingResult.rows.length > 0) {
        const existing = existingResult.rows[0];
        const existingMetadata = existing.metadata || {};

        if (
          Number(existing.amount_kobo) !== amountKobo
        ) {
          return res.status(409).json({
            success: false,
            message: "This idempotency key was used for another amount."
          });
        }

        return res.json({
          success: true,
          duplicate: true,
          reference: existing.reference,
          status: existing.status,
          authorization_url:
            existingMetadata.authorization_url || null,
          message: "Existing payment request retrieved."
        });
      }
    }

    const reference = generateReference();

    const metadata = {
      purpose: "wallet_funding",
      deposit_gross_kobo: breakdown.grossKobo,
      deposit_fee_kobo: breakdown.feeKobo,
      wallet_credit_kobo: breakdown.netKobo,
      deposit_fee_percent: DEPOSIT_FEE_PERCENT
    };

    await pool.query(
      `INSERT INTO transactions
       (
         user_id,
         reference,
         type,
         amount_kobo,
         status,
         provider,
         description,
         idempotency_key,
         metadata
       )
       VALUES
       ($1, $2, 'WALLET_FUNDING', $3, 'PENDING',
        'PAYSTACK', 'Wallet funding', $4, $5::jsonb)`,
      [
        req.user.id,
        reference,
        amountKobo,
        idempotencyKey || null,
        JSON.stringify(metadata)
      ]
    );

    const payload = {
      email: req.user.email,
      amount: amountKobo,
      reference,
      currency: "NGN",
      metadata: {
        user_id: req.user.id,
        purpose: "wallet_funding",
        deposit_fee_kobo: breakdown.feeKobo,
        wallet_credit_kobo: breakdown.netKobo
      }
    };

    if (process.env.PAYSTACK_CALLBACK_URL) {
      payload.callback_url = process.env.PAYSTACK_CALLBACK_URL;
    }

    const response = await fetch(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getPaystackSecret()}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000)
      }
    );

    let result = {};

    try {
      result = await response.json();
    } catch {
      throw new Error("INVALID_PAYSTACK_INITIALIZATION_RESPONSE");
    }

    if (
      !response.ok ||
      !result.status ||
      !result.data?.authorization_url
    ) {
      await pool.query(
        `UPDATE transactions
         SET status = 'FAILED',
             updated_at = NOW(),
             metadata = metadata || $2::jsonb
         WHERE reference = $1
           AND status = 'PENDING'`,
        [
          reference,
          JSON.stringify({
            initialization_failed: true
          })
        ]
      );

      return res.status(502).json({
        success: false,
        message: "Unable to initialize payment."
      });
    }

    await pool.query(
      `UPDATE transactions
       SET metadata = metadata || $2::jsonb,
           updated_at = NOW()
       WHERE reference = $1`,
      [
        reference,
        JSON.stringify({
          authorization_url: result.data.authorization_url
        })
      ]
    );

    return res.status(200).json({
      success: true,
      message: "Payment initialized successfully.",
      reference,
      authorization_url: result.data.authorization_url,
      access_code: result.data.access_code,
      payment: {
        amount_naira: breakdown.grossKobo / 100,
        service_charge_naira: breakdown.feeKobo / 100,
        wallet_credit_naira: breakdown.netKobo / 100,
        service_charge_percent: DEPOSIT_FEE_PERCENT,
        currency: "NGN"
      }
    });

  } catch (error) {
    console.error("Payment initialization error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Payment initialization failed. Check transaction status before retrying."
    });
  }
});

// CUSTOMER PAYMENT VERIFICATION
router.get(
  "/paystack/verify/:reference",
  authenticateToken,
  async (req, res) => {
    try {
      const reference = String(req.params.reference || "").trim();

      if (!reference || reference.length > 120) {
        return res.status(400).json({
          success: false,
          message: "Valid payment reference is required."
        });
      }

      const transactionResult = await pool.query(
        `SELECT reference, status, amount_kobo, metadata
         FROM transactions
         WHERE reference = $1
           AND user_id = $2
           AND type = 'WALLET_FUNDING'
           AND provider = 'PAYSTACK'`,
        [reference, req.user.id]
      );

      if (transactionResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Payment transaction not found."
        });
      }

      const existing = transactionResult.rows[0];

      if (existing.status === "SUCCESSFUL") {
        const metadata = existing.metadata || {};

        return res.json({
          success: true,
          status: "SUCCESSFUL",
          reference,
          wallet_credit_naira:
            Number(metadata.wallet_credit_kobo || 0) / 100,
          message: "Payment has already been processed."
        });
      }

      if (existing.status !== "PENDING") {
        return res.json({
          success: true,
          status: existing.status,
          reference
        });
      }

      const result = await verifyPayment(reference);

      return res.json({
        success: true,
        reference,
        status: result.status,
        duplicate: Boolean(result.duplicate),
        wallet_credit_naira:
          result.netKobo !== undefined
            ? result.netKobo / 100
            : null
      });

    } catch (error) {
      console.error("Payment verification error:", error.message);

      return res.status(502).json({
        success: false,
        message: "Unable to verify payment. Your wallet has not been credited unless verification succeeds."
      });
    }
  }
);

// SECURE PAYSTACK WEBHOOK
router.post("/paystack/webhook", async (req, res) => {
  try {
    const secret = getPaystackSecret();
    const signature = req.headers["x-paystack-signature"];

    if (!secret || !signature || !req.rawBody) {
      return res.sendStatus(400);
    }

    const expectedSignature = crypto
      .createHmac("sha512", secret)
      .update(req.rawBody)
      .digest("hex");

    const received = Buffer.from(String(signature), "hex");
    const expected = Buffer.from(expectedSignature, "hex");

    if (
      received.length !== expected.length ||
      !crypto.timingSafeEqual(received, expected)
    ) {
      return res.sendStatus(401);
    }

    const event = req.body;

    if (event?.event !== "charge.success") {
      return res.sendStatus(200);
    }

    const reference = String(
      event?.data?.reference || ""
    ).trim();

    if (!reference || reference.length > 120) {
      return res.sendStatus(200);
    }

    // Do not trust webhook payload alone.
    // Verify the payment directly with Paystack.
    await verifyPayment(reference);

    return res.sendStatus(200);

  } catch (error) {
    console.error("Paystack webhook error:", error.message);

    // Non-200 allows provider retry after temporary failure.
    return res.sendStatus(500);
  }
});

module.exports = router;
