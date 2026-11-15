
const express = require("express");
const authenticateToken = require("../middleware/auth");

const router = express.Router();

router.get("/me", authenticateToken, (req, res) => {
  return res.json({
    success: true,
    message: "Authentication verified successfully.",
    user: req.user
  });
});

module.exports = router;
