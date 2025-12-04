// api/webhook.js - ПРОСТАЯ версия для теста
module.exports = async function handler(req, res) {
  console.log('=== SIMPLE ORDER CHECK ===');
  
  if (req.method === 'GET') {
    return res.status(200).json({ 
      status: 'ready', 
      message: 'Test system',
      instruction: 'Create an order on website to test'
    });
  }
  
  try {
    // Просто логируем и говорим, что нужно делать
    console.log('POST request received');
    
    if (req.body) {
      console.log('Body:', JSON.stringify(req.body, null, 2));
    }
    
    res.status(200).json({
      success: true,
      message: 'System is ready. Next steps:',
      steps: [
        '1. Update code on Vercel with the working version above',
        '2. Create test order on website',
        '3. Check Insales to see if warehouse changed',
        '4. Setup cron-job.org to run every 5 minutes'
      ]
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
};
