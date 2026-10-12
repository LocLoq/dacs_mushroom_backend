const express = require('express');
const router = express.Router();
const { handle } = require('../services/apiHelpers');

router.get('/test', handle((req, res) => {
    res.json({status: "running"});
}));

module.exports = router;
