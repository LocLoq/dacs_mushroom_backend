const express = require('express');
const multer = require('multer');
const router = express.Router();
const mushroomClassifierQueue = require('../queues/mushroomClassifierQueue');

const upload = multer({ dest: 'uploads/' });

router.post('/classify', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Image file is required' });
        }

        const jobId = Date.now().toString();
        
        // Add job to queue
        await mushroomClassifierQueue.add({
            jobId,
            service: 'mushroom',
            filename: req.file.filename,
            originalName: req.file.originalname,
            path: req.file.path
        });

        res.json({ message: 'Job added to queue', jobId });
    } catch (error) {
        console.error('Error in /classify route:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;

