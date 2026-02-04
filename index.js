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

class ConversationManager {
  constructor() {
    // Cleanup old conversations every 10 minutes
    setInterval(() => this.cleanupOldConversations(), 10 * 60 * 1000);
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
  try {
    const body = req.body;
    console.log('Webhook received');

    if (body.object === 'page') {
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

            console.log(`Message from ${senderID}: ${userMessage}`);

            try {
              sendTypingIndicator(senderID, true).catch(() => {});

              // Check for special commands
              if (userMessage.toLowerCase() === '/clear' || userMessage.toLowerCase() === '/reset') {
                conversationManager.clearConversation(senderID);
                await sendFacebookMessage(senderID, "🔄 Conversation cleared! Let's start fresh. What would you like to talk about?");
                continue;
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
                  response = "🤖 I'm an AI assistant powered by OpenRouter.\n\n🧠 **New Feature:** I now remember our conversation! This means:\n• I can refer back to what we discussed\n• You can ask follow-up questions\n• Context is preserved\n\nI can help with:\n• General knowledge\n• Explanations\n• Problem-solving\n• Creative writing\n• And much more!\n\nWhat would you like to know?";
                  break;
                  
                case 'START_CHAT':
                  response = "💬 Great! I'm ready to chat. Ask me anything you'd like to know!";
                  break;
                  
                case 'HELP':
                  response = "🆘 **How to use me:**\n\n1️⃣ Just type your question\n2️⃣ I'll respond with helpful information\n3️⃣ You can ask follow-up questions - I remember!\n\n**Commands:**\n• /clear or /reset - Start a fresh conversation\n\n**Tips:**\n• Be specific for better answers\n• I remember our chat (last 10 messages)\n• I can't access real-time info (sports scores, news)\n• I'm here 24/7!\n\nWhat can I help you with?";
                  break;
                  
                case 'MAIN_MENU':
                  response = "🏠 **Main Menu**\n\nWhat would you like to do?\n\n• Ask me a question\n• Learn what I can do\n• Get help using the bot\n• Type /clear to reset conversation\n\nJust type your message!";
                  break;

                case 'CLEAR_CHAT':
                  conversationManager.clearConversation(senderID);
                  response = "🔄 Conversation cleared! Let's start fresh. What would you like to talk about?";
                  break;
                  
                default:
                  response = "I'm here to help! What would you like to know?";
              }
              
              await sendFacebookMessage(senderID, response);
              console.log('Postback response sent');

            } catch (error) {
              console.error('Error handling postback:', error.message);
            }
          }
        }
      }
    }

    res.status(200).send('EVENT_RECEIVED');

  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).send('ERROR');
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

// Typing indicator
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
  
  // Add previous messages (excluding current one since we'll add it separately)
  for (let i = 0; i < history.length - 1; i++) {
    const msg = history[i];
    messages.push({
      role: msg.role,
      content: msg.content
    });
  }

  // Add current user message
  messages.push({
    role: 'user',
    content: userMessage
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/yourusername/messenger-bot', // Optional
      'X-Title': 'Messenger AI Bot' // Optional
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-3.1-8b-instruct:free', // Free model
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
  res.send(`🤖 AI Bot - OpenRouter (Llama 3.1 8B)
  
🧠 Memory Enabled
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