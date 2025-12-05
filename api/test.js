// Простой тест endpoint
export default function handler(req, res) {
  return res.status(200).json({
    status: 'online',
    message: 'Webhook service is running',
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    endpoints: {
      webhook: 'POST /api/webhook',
      test: 'GET /api/test'
    }
  });
}
