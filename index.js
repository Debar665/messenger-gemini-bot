const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json());

// Load from environment variables
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'my_secret_verify_token_12345';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;


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
  console.log('═══════════════════════════════════════');
  console.log('📥 WEBHOOK POST RECEIVED');
  console.log('Time:', new Date().toISOString());
  
  try {
    const body = req.body;
    console.log('Request body:', JSON.stringify(body, null, 2));

    if (body.object === 'page') {
      console.log('✅ Valid page object');
      
      for (const entry of body.entry) {
        const pageID = entry.id;
        console.log(`📄 Processing entry for page: ${pageID}`);
        
        for (const event of entry.messaging) {
          console.log('📨 Event type:', Object.keys(event).join(', '));
          
          // Handle regular messages
          if (event.message && 
              event.message.text && 
              !event.message.is_echo &&
              event.sender &&
              event.sender.id !== pageID) {
            
            const senderID = event.sender.id;
            const userMessage = event.message.text;

            console.log('═══════════════════════════════════════');
            console.log(`👤 Message from user: ${senderID}`);
            console.log(`💬 Message text: "${userMessage}"`);
            console.log('═══════════════════════════════════════');

            try {
              console.log('✅ Starting to process message...');
              
              // Start typing indicator (will repeat every 5s)
              startTyping(senderID);
              console.log('⌨️ Typing indicator started');

              // Check for special commands
              if (userMessage.toLowerCase() === '/clear' || userMessage.toLowerCase() === '/reset') {
                console.log('🔄 Clear command detected');
                conversationManager.clearConversation(senderID);
                await sendFacebookMessage(senderID, "🔄 Conversation cleared! Let's start fresh. What would you like to talk about?");
                console.log('✅ Clear command completed');
                continue;
              }

              // Add user message to history
              console.log('💾 Adding message to history...');
              conversationManager.addMessage(senderID, 'user', userMessage);

              // Get AI response with conversation history
              console.log('🤖 Calling Gemini API...');
              const aiReply = await callGeminiAPI(senderID, userMessage);
              console.log(`✅ Gemini response received: "${aiReply.substring(0, 50)}..."`);

              // Add AI response to history
              console.log('💾 Adding AI response to history...');
              conversationManager.addMessage(senderID, 'assistant', aiReply);

              console.log('📤 Sending message to Facebook...');
              await sendFacebookMessage(senderID, aiReply);
              console.log('✅ Message sent successfully!');

            } catch (error) {
              console.error('❌ ERROR in message processing:');
              console.error('Error message:', error.message);
              console.error('Error stack:', error.stack);
              console.error('Error type:', error.name);
              
              try {
                console.log('⚠️ Attempting to send error message to user...');
                await sendFacebookMessage(senderID, 'Sorry, I had trouble with that. Try again?');
                console.log('✅ Error message sent');
              } catch (sendError) {
                console.error('❌ Failed to send error message:', sendError.message);
                console.error('Send error stack:', sendError.stack);
              }
            } finally {
              // Always stop typing indicator
              console.log('🛑 Stopping typing indicator...');
              stopTyping(senderID);
              console.log('═══════════════════════════════════════');
            }
          }
          
          // Handle button clicks (postbacks)
          else if (event.postback) {
            const senderID = event.sender.id;
            const payload = event.postback.payload;

            console.log('═══════════════════════════════════════');
            console.log(`🔘 Postback from ${senderID}: ${payload}`);
            console.log('═══════════════════════════════════════');

            try {
              // Show typing for postback responses too
              startTyping(senderID);
              
              let response = '';
              
              switch(payload) {
                case 'GET_STARTED':
                  // Clear conversation on fresh start
                  conversationManager.clearConversation(senderID);
                  response = "👋 Welcome! I'm your AI assistant. I can:\n\n✅ Answer questions\n✅ Provide information\n✅ Have intelligent conversations\n✅ Remember our chat context\n\nJust type your question and I'll respond!\n\n💡 Tip: Type /clear to reset our conversation.";
                  break;
                  
                case 'ABOUT_BOT':
                  response = "🤖 I'm an AI assistant powered by Google Gemini 2.5 Flash-Lite.\n\n🧠 **New Feature:** I now remember our conversation! This means:\n• I can refer back to what we discussed\n• You can ask follow-up questions\n• Context is preserved\n\nI can help with:\n• General knowledge\n• Explanations\n• Problem-solving\n• Creative writing\n• And much more!\n\nWhat would you like to know?";
                  break;
                  
                case 'START_CHAT':
                  response = "💬 Great! I'm ready to chat. Ask me anything you'd like to know!";
                  break;
                  
                case 'HELP':
                  response = "🆘 **How to use me:**\n\n1️⃣ Just type your question\n2️⃣ I'll respond with helpful information\n3️⃣ You can ask follow-up questions - I remember!\n\n**Commands:**\n• /clear or /reset - Start a fresh conversation\n\n**Tips:**\n• Be specific for better answers\n• I remember our chat (last 10 messages)\n• I'm here 24/7!\n\nWhat can I help you with?";
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
            } finally {
              stopTyping(senderID);
            }
          }
        }
      }
    } else {
      console.log('⚠️ Not a page object:', body.object);
    }

    console.log('✅ Sending 200 response to Facebook');
    res.status(200).send('EVENT_RECEIVED');
    console.log('═══════════════════════════════════════');

  } catch (error) {
    console.error('═══════════════════════════════════════');
    console.error('❌ WEBHOOK ERROR');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('═══════════════════════════════════════');
    res.status(500).send('ERROR');
  }
});

// ============================================
// TYPING INDICATOR SYSTEM
// ============================================

// Active typing intervals per user
const typingIntervals = new Map();

// Send typing indicator (single)
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

// Start continuous typing indicator (repeats every 5 seconds)
function startTyping(recipientID) {
  // Clear any existing interval
  stopTyping(recipientID);
  
  // Send initial typing indicator
  sendTypingIndicator(recipientID, true).catch(() => {});
  
  // Keep sending every 5 seconds (Facebook's typing indicator lasts ~20 seconds)
  const interval = setInterval(() => {
    sendTypingIndicator(recipientID, true).catch(() => {});
  }, 5000);
  
  typingIntervals.set(recipientID, interval);
}

// Stop typing indicator
function stopTyping(recipientID) {
  // Clear interval if exists
  if (typingIntervals.has(recipientID)) {
    clearInterval(typingIntervals.get(recipientID));
    typingIntervals.delete(recipientID);
  }
  
  // Send typing off
  sendTypingIndicator(recipientID, false).catch(() => {});
}

// ============================================
// HELPER FUNCTIONS
// ============================================

// Call Gemini API with conversation history
async function callGeminiAPI(userID, userMessage) {
  console.log('🔵 callGeminiAPI started');
  console.log(`   User ID: ${userID}`);
  console.log(`   Message: "${userMessage}"`);
  
  if (!GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY is not set!');
    throw new Error('Gemini API key not configured');
  }
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

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

  let systemPrompt = `You are a helpful AI assistant. Today is ${dateStr}, ${timeStr} (Iraq time).

Keep responses SHORT and conversational. You can reference previous messages in this conversation.`;

  // Get conversation history
  console.log('📚 Getting conversation history...');
  const history = conversationManager.getHistory(userID);
  console.log(`   History length: ${history.length} messages`);

  // Build contents array with history for Gemini
  const historyForGemini = [];
  
  // Add previous messages (excluding current one since we'll add it separately)
  for (let i = 0; i < history.length - 1; i++) {
    const msg = history[i];
    historyForGemini.push({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    });
  }

  // Add current user message
  historyForGemini.push({
    role: 'user',
    parts: [{ text: userMessage }]
  });

  console.log(`📦 Prepared ${historyForGemini.length} messages for Gemini`);
  console.log('🌐 Calling Gemini API...');
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: historyForGemini,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1000
        }
      })
    });

    console.log(`📡 Gemini API response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Gemini API error: ${response.status}`);
      console.error(`Error response: ${errorText}`);
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('✅ Gemini API response parsed successfully');
    
    if (data.candidates && data.candidates[0] && data.candidates[0].content) {
      const reply = data.candidates[0].content.parts[0].text;
      console.log(`✅ Got reply: "${reply.substring(0, 100)}..."`);
      return reply;
    }
    
    console.error('❌ No valid response from Gemini');
    console.error('Response data:', JSON.stringify(data, null, 2));
    throw new Error('No Gemini response');
    
  } catch (fetchError) {
    console.error('❌ Fetch error in callGeminiAPI:');
    console.error('Error message:', fetchError.message);
    console.error('Error stack:', fetchError.stack);
    throw fetchError;
  }
}

// Send message to Facebook
async function sendFacebookMessage(recipientID, messageText) {
  console.log('📤 sendFacebookMessage called');
  console.log(`   Recipient: ${recipientID}`);
  console.log(`   Message: "${messageText.substring(0, 100)}..."`);
  
  if (!PAGE_ACCESS_TOKEN) {
    console.error('❌ PAGE_ACCESS_TOKEN is not set!');
    throw new Error('Facebook access token not configured');
  }
  
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  console.log('🌐 Sending to Facebook API...');
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientID },
        message: { text: messageText }
      })
    });

    console.log(`📡 Facebook API response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Facebook API error: ${response.status}`);
      console.error(`Error response: ${errorText}`);
      throw new Error(`Facebook error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log('✅ Message sent to Facebook successfully');
    return result;
    
  } catch (fetchError) {
    console.error('❌ Error in sendFacebookMessage:');
    console.error('Error message:', fetchError.message);
    console.error('Error stack:', fetchError.stack);
    throw fetchError;
  }
}

// ============================================
// SERVER ROUTES
// ============================================

// Health check
app.get('/', (req, res) => {
  const stats = conversationManager.getStats();
  res.send(`🤖 AI Bot - Google Gemini 2.5 Flash-Lite
  
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
  console.log('═══════════════════════════════════════');
  console.log('🚀 SERVER STARTING');
  console.log('═══════════════════════════════════════');
  console.log(`📍 Port: ${PORT}`);
  console.log(`🕐 Time: ${new Date().toISOString()}`);
  console.log('');
  console.log('🔑 ENVIRONMENT VARIABLES STATUS:');
  console.log(`   PAGE_ACCESS_TOKEN: ${PAGE_ACCESS_TOKEN ? '✅ SET' : '❌ NOT SET'}`);
  console.log(`   VERIFY_TOKEN: ${VERIFY_TOKEN ? '✅ SET' : '❌ NOT SET'}`);
  console.log(`   GEMINI_API_KEY: ${GEMINI_API_KEY ? '✅ SET' : '❌ NOT SET'}`);
  console.log('');
  console.log('🧠 Conversation memory: ENABLED');
  console.log('');
  console.log('✅ Server ready to receive messages');
  console.log('═══════════════════════════════════════');
});

module.exports = app;