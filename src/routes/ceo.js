const express = require("express");
const pool = require("../config/database");
const requireCeo = require("../middleware/requireCeo");
const { getCeoRevenueReport } = require("../services/ceoRevenue");
const { getWalletBalance } = require("../services/meleData");

const router = express.Router();
router.use(requireCeo);

router.get("/revenue", async (req, res) => {
  try {
    const report = await getCeoRevenueReport(pool);
    return res.json({ success: true, report });
  } catch (error) {
    console.error("CEO revenue report error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to retrieve company revenue report."
    });
  }
});

router.get("/mele-wallet", async (req, res) => {
  try {
    const wallet = await getWalletBalance();
    return res.json({ success: true, wallet });
  } catch (error) {
    console.error("MELE wallet balance error:", error.code || error.message);
    return res.status(error.status || 502).json({
      success: false,
      code: error.code || "MELE_WALLET_UNAVAILABLE",
      message: error.message
    });
  }
});

module.exports = router;
