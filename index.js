const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json());

// Load from environment variables
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'my_secret_verify_token_12345';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// ============================================
// CONVERSATION MEMORY SYSTEM
// ============================================

// Store conversations in memory (per Vercel instance)
// NOTE: On Vercel, this persists only during the instance lifetime
// For production, consider using Vercel KV, Upstash Redis, or similar
const conversations = new Map();

// Configuration
const MAX_HISTORY_MESSAGES = 10; // Keep last 10 messages per user
const CONVERSATION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Track processed messages to prevent duplicates
const processedMessages = new Set();
const MESSAGE_EXPIRE_TIME = 5 * 60 * 1000; // 5 minutes

class ConversationManager {
  constructor() {
    // Cleanup old conversations every 10 minutes
    setInterval(() => this.cleanupOldConversations(), 10 * 60 * 1000);
    // Cleanup processed message IDs every minute
    setInterval(() => this.cleanupProcessedMessages(), 60 * 1000);
  }

  getConversation(userID) {
    if (!conversations.has(userID)) {
      conversations.set(userID, {
        messages: [],
        lastActivity: Date.now()
      });
    }
    return conversations.get(userID);
  }

  addMessage(userID, role, content) {
    const conv = this.getConversation(userID);
    conv.messages.push({
      role: role, // 'user' or 'assistant'
      content: content,
      timestamp: Date.now()
    });
    conv.lastActivity = Date.now();

    // Keep only recent messages to prevent memory issues
    if (conv.messages.length > MAX_HISTORY_MESSAGES) {
      conv.messages = conv.messages.slice(-MAX_HISTORY_MESSAGES);
    }
  }

  getHistory(userID) {
    const conv = this.getConversation(userID);
    return conv.messages;
  }

  clearConversation(userID) {
    conversations.delete(userID);
  }

  cleanupOldConversations() {
    const now = Date.now();
    for (const [userID, conv] of conversations.entries()) {
      if (now - conv.lastActivity > CONVERSATION_TIMEOUT) {
        conversations.delete(userID);
        console.log(`Cleaned up conversation for user ${userID}`);
      }
    }
  }

  cleanupProcessedMessages() {
    const now = Date.now();
    for (const msgKey of processedMessages) {
      const [timestamp] = msgKey.split(':');
      if (now - parseInt(timestamp) > MESSAGE_EXPIRE_TIME) {
        processedMessages.delete(msgKey);
      }
    }
  }

  getStats() {
    return {
      activeConversations: conversations.size,
      totalMessages: Array.from(conversations.values())
        .reduce((sum, conv) => sum + conv.messages.length, 0)
    };
  }
}

const conversationManager = new ConversationManager();

// ============================================
// WEBHOOK ENDPOINTS
// ============================================

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Receive messages and postbacks
app.post('/webhook', async (req, res) => {
  // CRITICAL: Send 200 response immediately to prevent Facebook retries
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    console.log('Webhook received:', JSON.stringify(body, null, 2));

    if (body.object === 'page') {
      // Process messages asynchronously (after responding to Facebook)
      processWebhookEvents(body).catch(err => {
        console.error('Error processing webhook events:', err);
      });
    }
  } catch (error) {
    console.error('Webhook error:', error);
  }
});

// Process webhook events asynchronously
async function processWebhookEvents(body) {
  for (const entry of body.entry) {
    const pageID = entry.id;
    
    for (const event of entry.messaging) {
      // Handle regular messages
      if (event.message && 
          event.message.text && 
          !event.message.is_echo &&
          event.sender &&
          event.sender.id !== pageID) {
        
        const senderID = event.sender.id;
        const userMessage = event.message.text;
        const messageID = event.message.mid;

        // Create unique message key to prevent duplicates
        const messageKey = `${Date.now()}:${senderID}:${messageID}`;
        
        // Skip if already processed
        if (processedMessages.has(messageKey)) {
          console.log(`Skipping duplicate message: ${messageID}`);
          return;
        }
        
        // Mark as processed
        processedMessages.add(messageKey);

        console.log(`Message from ${senderID}: ${userMessage}`);

        try {
          sendTypingIndicator(senderID, true).catch(() => {});

          // Check for special commands
          if (userMessage.toLowerCase() === '/clear' || userMessage.toLowerCase() === '/reset') {
            conversationManager.clearConversation(senderID);
            await sendFacebookMessage(senderID, "🔄 Conversation cleared! Let's start fresh. What would you like to talk about?");
            continue;
          }

          // Check for weather requests
          const lowerMessage = userMessage.toLowerCase().trim();
          if (lowerMessage.includes('weather') || lowerMessage.includes('temperature') || lowerMessage.includes('temp')) {
            let city = '';
            
            // Pattern 1: "weather in London", "temperature in Baghdad", etc.
            const patterns = [
              /weather\s+in\s+([a-zA-Z\s]+)/i,
              /weather\s+for\s+([a-zA-Z\s]+)/i,
              /temperature\s+in\s+([a-zA-Z\s]+)/i,
              /temperature\s+for\s+([a-zA-Z\s]+)/i,
              /temp\s+in\s+([a-zA-Z\s]+)/i,
              /temp\s+for\s+([a-zA-Z\s]+)/i
            ];
            
            for (const pattern of patterns) {
              const match = userMessage.match(pattern);
              if (match && match[1]) {
                city = match[1].trim();
                break;
              }
            }
            
            // Pattern 2: "London weather", "Baghdad temperature"
            if (!city) {
              const reversePatterns = [
                /^([a-zA-Z\s]+)\s+weather/i,
                /^([a-zA-Z\s]+)\s+temperature/i,
                /^([a-zA-Z\s]+)\s+temp/i
              ];
              
              for (const pattern of reversePatterns) {
                const match = userMessage.match(pattern);
                if (match && match[1]) {
                  city = match[1].trim();
                  break;
                }
              }
            }
            
            if (city && city.length > 2) {
              const weatherInfo = await getWeather(city);
              await sendFacebookMessage(senderID, weatherInfo);
              sendTypingIndicator(senderID, false).catch(() => {});
              continue;
            } else {
              await sendFacebookMessage(senderID, "🌍 Which city's weather would you like to know? (e.g., 'weather in Baghdad')");
              sendTypingIndicator(senderID, false).catch(() => {});
              continue;
            }
          }


          // Add user message to history
          conversationManager.addMessage(senderID, 'user', userMessage);

          // Get AI response with conversation history
          const aiReply = await callOpenRouterAPI(senderID, userMessage);
          console.log('OpenRouter response received');

          // Add AI response to history
          conversationManager.addMessage(senderID, 'assistant', aiReply);

          await sendFacebookMessage(senderID, aiReply);
          console.log('Message sent successfully');

        } catch (error) {
          console.error('Error:', error.message);
          try {
            await sendFacebookMessage(senderID, 'Sorry, I had trouble with that. Try again?');
          } catch (sendError) {
            console.error('Failed to send error:', sendError.message);
          }
        } finally {
          sendTypingIndicator(senderID, false).catch(() => {});
        }
      }
      
      // Handle button clicks (postbacks)
      else if (event.postback) {
        const senderID = event.sender.id;
        const payload = event.postback.payload;

        console.log(`Postback from ${senderID}: ${payload}`);

        try {
          let response = '';
          
          switch(payload) {
            case 'GET_STARTED':
              // Clear conversation on fresh start
              conversationManager.clearConversation(senderID);
              response = "👋 Welcome! I'm your AI assistant. I can:\n\n✅ Answer questions\n✅ Provide information\n✅ Have intelligent conversations\n✅ Remember our chat context\n\nJust type your question and I'll respond!\n\n💡 Tip: Type /clear to reset our conversation.";
              break;
              
            case 'ABOUT_BOT':
              response = "🤖 I'm an AI-powered chatbot that can:\n\n💬 Chat naturally\n🧠 Remember our conversation\n🌡️ Check weather for cities\n📚 Answer questions\n\nBuilt with OpenRouter AI and running 24/7!";
              break;
              
            case 'HELP':
              response = "📖 Here's how to use me:\n\n💬 Just type any question\n🌡️ Ask 'weather in [city]'\n🔄 Type /clear to reset chat\n\nI remember our conversation, so feel free to ask follow-up questions!";
              break;
              
            default:
              response = "I received your message! How can I help you?";
          }
          
          await sendFacebookMessage(senderID, response);
          
        } catch (error) {
          console.error('Postback error:', error.message);
        }
      }
    }
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

// Typing indicator

// Normalize city names (handle alternative spellings)
function normalizeCity(city) {
  const cityMap = {
    // Sulaymaniyah variations
    'slemani': 'Sulaymaniyah',
    'slemanyah': 'Sulaymaniyah',
    'sulaumanyah': 'Sulaymaniyah',
    'sulaimani': 'Sulaymaniyah',
    'slemany': 'Sulaymaniyah',
    
    // Erbil variations
    'hawler': 'Erbil',
    'arbil': 'Erbil',
    'irbil': 'Erbil',
    
    // Duhok variations
    'dwhok': 'Duhok',
    'dhok': 'Duhok',
    'dahok': 'Duhok',
    'dihok': 'Duhok',
    
    // Halabja variations
    '7alabja': 'Halabja',
    'halabjah': 'Halabja',
    'halabja': 'Halabja',
    
    // Baghdad variations
    'bghdad': 'Baghdad',
    'baghdad': 'Baghdad'
  };
  
  const lowerCity = city.toLowerCase().trim();
  return cityMap[lowerCity] || city;
}

// Get weather information using Open-Meteo (no API key needed!)
async function getWeather(city) {
  try {
    // Normalize city name for alternative spellings
    const normalizedCity = normalizeCity(city);
    
    // Step 1: Get coordinates for the city
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(normalizedCity)}&count=1&language=en&format=json`;
    const geoResponse = await fetch(geoUrl);
    const geoData = await geoResponse.json();

    if (!geoData.results || geoData.results.length === 0) {
      return `❌ Couldn't find "${city}". Try another city name (e.g., "Baghdad", "Erbil", "Slemani").`;
    }

    const location = geoData.results[0];
    const { latitude, longitude, name, country } = location;

    // Step 2: Get weather data
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto`;
    const weatherResponse = await fetch(weatherUrl);
    const weatherData = await weatherResponse.json();

    const current = weatherData.current;
    const weatherCode = current.weather_code;
    
    // Convert weather code to description
    const weatherDescriptions = {
      0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
      45: 'Foggy', 48: 'Foggy', 51: 'Light drizzle', 53: 'Moderate drizzle',
      55: 'Dense drizzle', 61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
      71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 80: 'Rain showers',
      81: 'Moderate rain showers', 82: 'Violent rain showers', 95: 'Thunderstorm',
      96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail'
    };
    
    const condition = weatherDescriptions[weatherCode] || 'Unknown';

    return `🌡️ Weather in ${name}, ${country}:
📍 Temperature: ${current.temperature_2m}°C
☁️ Condition: ${condition}
💧 Humidity: ${current.relative_humidity_2m}%
💨 Wind: ${current.wind_speed_10m} km/h`;
    
  } catch (error) {
    console.error('Weather API error:', error);
    return "❌ Error getting weather data. Please try again.";
  }
}

async function sendTypingIndicator(recipientID, isTyping) {
  try {
    await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientID },
        sender_action: isTyping ? 'typing_on' : 'typing_off'
      })
    });
  } catch (error) {
    // Ignore typing indicator errors
  }
}

// Call OpenRouter API with conversation history
async function callOpenRouterAPI(userID, userMessage) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OpenRouter API key not configured');
  }

  const url = 'https://openrouter.ai/api/v1/chat/completions';

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Baghdad'
  });

  // System message
  const systemMessage = {
    role: 'system',
    content: `You are a helpful AI assistant. Today is ${dateStr}, ${timeStr} (Iraq time).

Keep responses SHORT and conversational. You can reference previous messages in this conversation. If asked about real-time info (sports scores, news), politely say you can't access live data.`
  };

  // Get conversation history
  const history = conversationManager.getHistory(userID);

  // Build messages array with history
  const messages = [systemMessage];
  
  // Add ALL previous messages from history
  for (const msg of history) {
    messages.push({
      role: msg.role,
      content: msg.content
    });
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/yourusername/messenger-bot', // Optional
      'X-Title': 'Messenger AI Bot' // Optional
    },
    body: JSON.stringify({
      model: 'tngtech/deepseek-r1t2-chimera:free', // Free model
      messages: messages,
      temperature: 0.7,
      max_tokens: 1000
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('OpenRouter API error:', errorText);
    throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  }
  
  throw new Error('No response from OpenRouter');
}

// Send message to Facebook
async function sendFacebookMessage(recipientID, messageText) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientID },
      message: { text: messageText }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Facebook error: ${response.status}`);
  }

  return await response.json();
}

// ============================================
// SERVER ROUTES
// ============================================

// Health check
app.get('/', (req, res) => {
  const stats = conversationManager.getStats();
  res.send(`🤖 AI Bot - OpenRouter (DeepSeek R1T2 Chimera)
  
🧠 Memory Enabled
🌡️ Weather: Enabled ✅ (Open-Meteo - No API key needed!)
📊 Active conversations: ${stats.activeConversations}
💬 Total messages stored: ${stats.totalMessages}`);
});


// Stats endpoint (for monitoring)
app.get('/stats', (req, res) => {
  res.json(conversationManager.getStats());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('🧠 Conversation memory enabled');
  console.log(`🤖 Using OpenRouter API: ${OPENROUTER_API_KEY ? 'Configured ✅' : 'NOT SET ❌'}`);
});

module.exports = app;