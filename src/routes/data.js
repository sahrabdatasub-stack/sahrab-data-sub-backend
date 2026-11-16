
const express = require("express");
const authenticateToken = require("../middleware/auth");

const router = express.Router();

// GET AVAILABLE DATA PLANS FROM VTU AGENT
router.get("/plans", authenticateToken, async (req, res) => {
  try {
    if (
      process.env.VTUAGENT_ENABLED !== "true" ||
      !process.env.VTUAGENT_API_KEY
    ) {
      return res.status(503).json({
        success: false,
        message: "Data supplier is not configured."
      });
    }

    const baseUrl = (
      process.env.VTUAGENT_BASE_URL || "https://api.vtuagent.com/v1"
    ).replace(/\/+$/, "");

    const response = await fetch(`${baseUrl}/data/plans`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.VTUAGENT_API_KEY}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(20000)
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("VTU Agent plans request failed:", response.status);

      return res.status(502).json({
        success: false,
        message: "Unable to retrieve data plans from supplier."
      });
    }

    return res.json({
      success: true,
      message: "Data plans retrieved successfully.",
      plans: result
    });

  } catch (error) {
    console.error("Data plans error:", error.message);

    return res.status(502).json({
      success: false,
      message: "Data supplier is temporarily unavailable."
    });
  }
});

module.exports = router;
