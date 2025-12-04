// api/webhook.js - максимально упрощенная версия
const axios = require('axios');

module.exports = async function handler(req, res) {
  console.log('=== SIMPLE TEST ===');
  
  try {
    // Просто тестируем подключение
    const testUrl = 'https://0c2a7555e80a577feb222d2eb8921c25:dtc9369c625872e91dcfa7e5675e5675e6066@myshop-btf167.myinsales.ru/admin/orders.json?per_page=1';
    
    console.log('Testing URL:', testUrl);
    
    const response = await axios.get(testUrl);
    
    console.log('✅ API connected! Orders found:', response.data.length);
    
    if (response.data.length > 0) {
      const order = response.data[0];
      console.log('First order:', {
        id: order.id,
        number: order.number,
        warehouse_id: order.warehouse_id
      });
    }
    
    res.status(200).json({
      success: true,
      orders: response.data.length,
      test: 'API connection successful'
    });
    
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
    
    // Пробуем альтернативный пароль
    if (error.message.includes('401')) {
      console.log('Trying alternative password...');
      
      try {
        const altUrl = 'https://0c2a7555e80a577feb222d2eb8921c25:dtc9369c625872e91dcfa7e5675e6066@myshop-btf167.myinsales.ru/admin/orders.json?per_page=1';
        const altResponse = await axios.get(altUrl);
        
        console.log('✅ Alternative password works!');
        
        res.status(200).json({
          success: true,
          message: 'Alternative password works',
          orders: altResponse.data.length
        });
        
      } catch (altError) {
        res.status(500).json({
          success: false,
          error: 'Both passwords failed',
          mainError: error.message,
          altError: altError.message
        });
      }
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
};
