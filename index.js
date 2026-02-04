const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json());

// Load from environment variables (SECURE!)
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'my_secret_verify_token_12345';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Conversation memory - stores last 5 messages per user
const conversationHistory = new Map();
const MAX_HISTORY = 5;

// Rate limiting - prevent spam
const userLastMessage = new Map();
const RATE_LIMIT_MS = 2000; // 2 seconds between messages

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    console.error('Webhook verification failed');
    res.sendStatus(403);
  }
});

// Receive messages
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    
    if (body.object === 'page') {
      // Send 200 OK immediately to Facebook
      res.status(200).send('EVENT_RECEIVED');
      
      // Process entries
      for (const entry of body.entry) {
        const pageID = entry.id;
        
        for (const event of entry.messaging) {
          // Only process user messages (not echoes, not from page)
          if (event.message && 
              event.message.text && 
              !event.message.is_echo &&
              event.sender &&
              event.sender.id !== pageID) {
            
            const senderID = event.sender.id;
            const userMessage = event.message.text;

            console.log(`📨 Message from user ${senderID}: "${userMessage}"`);

            // Rate limiting - prevent spam
            const now = Date.now();
            const lastMessageTime = userLastMessage.get(senderID) || 0;
            
            if (now - lastMessageTime < RATE_LIMIT_MS) {
              console.log(`⏱️ Rate limit: User ${senderID} sending too fast`);
              continue; // Skip this message
            }
            
            userLastMessage.set(senderID, now);

            // Show typing indicator
            await sendTypingIndicator(senderID, true);

            try {
              // Get AI response with conversation context
              const aiReply = await getAIResponse(senderID, userMessage);
              
              // Split long messages into chunks (max 2000 chars per message)
              const messageChunks = splitMessage(aiReply, 2000);
              
              // Send each chunk
              for (let i = 0; i < messageChunks.length; i++) {
                if (i > 0) {
                  // Small delay between chunks for natural feel
                  await sleep(1000);
                }
                await sendFacebookMessage(senderID, messageChunks[i]);
              }
              
              console.log(`✅ Response sent to user ${senderID}`);

            } catch (error) {
              console.error(`❌ Error processing message for ${senderID}:`, error.message);
              await sendFacebookMessage(senderID, '😔 Sorry, I encountered an error. Please try again in a moment.');
            } finally {
              // Turn off typing indicator
              await sendTypingIndicator(senderID, false);
            }
          }
        }
      }
    } else {
      res.sendStatus(404);
    }

  } catch (error) {
    console.error('💥 Webhook error:', error.message);
    res.status(500).send('ERROR');
  }
});

// Get AI response with conversation context
async function getAIResponse(userID, message) {
  // Get or create conversation history for this user
  if (!conversationHistory.has(userID)) {
    conversationHistory.set(userID, []);
  }
  
  const history = conversationHistory.get(userID);
  
  // Add user message to history
  history.push({
    role: 'user',
    content: message
  });
  
  // Keep only last MAX_HISTORY messages
  if (history.length > MAX_HISTORY * 2) { // *2 because user + assistant
    history.splice(0, history.length - (MAX_HISTORY * 2));
  }
  
  // Get current date/time for context
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

  const systemPrompt = `You are a helpful, friendly AI assistant chatting via Facebook Messenger.

CURRENT CONTEXT:
- Date: ${dateStr}
- Time: ${timeStr} (Iraq time)
- Platform: Facebook Messenger (mobile-first)

RESPONSE GUIDELINES:
- Keep responses concise and conversational (2-4 short paragraphs max)
- Use natural, friendly language - like texting a friend
- Break complex info into digestible chunks
- Use emojis sparingly but naturally when appropriate
- For lists, keep them short (max 5 items)
- If asked about real-time info (sports scores, current news, stock prices), politely explain you don't have access to live data and suggest they search online

IMPORTANT LIMITATIONS:
- You cannot access real-time information or current events
- You cannot browse the web or see live data
- Your knowledge has a cutoff date

Be helpful, honest, and concise!`;

  try {
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://messenger-gemini-bot.vercel.app',
        'X-Title': 'Messenger AI Bot'
      },
      body: JSON.stringify({
        model: 'tngtech/deepseek-r1t2-chimera:free',
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          ...history // Include conversation history
        ],
        temperature: 0.7,
        max_tokens: 1500 // Limit to keep responses concise
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    if (data.choices && data.choices[0] && data.choices[0].message) {
      const aiMessage = data.choices[0].message.content;
      
      // Add AI response to history
      history.push({
        role: 'assistant',
        content: aiMessage
      });
      
      conversationHistory.set(userID, history);
      
      return aiMessage;
    }
    
    throw new Error('No response from AI');
    
  } catch (error) {
    console.error('AI API error:', error.message);
    throw error;
  }
}

// Send typing indicator
async function sendTypingIndicator(recipientID, isTyping) {
  try {
    const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
    
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { id: recipientID },
        sender_action: isTyping ? 'typing_on' : 'typing_off'
      })
    });
  } catch (error) {
    // Don't throw - typing indicator failure shouldn't break the flow
    console.warn('⚠️ Typing indicator failed:', error.message);
  }
}

// Send message to Facebook
async function sendFacebookMessage(recipientID, messageText) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      recipient: { id: recipientID },
      message: { text: messageText }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Facebook API error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

// Split long messages into chunks
function splitMessage(text, maxLength = 2000) {
  if (text.length <= maxLength) {
    return [text];
  }
  
  const chunks = [];
  let currentChunk = '';
  
  // Split by paragraphs first
  const paragraphs = text.split('\n\n');
  
  for (const paragraph of paragraphs) {
    if ((currentChunk + paragraph).length > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      
      // If single paragraph is too long, split by sentences
      if (paragraph.length > maxLength) {
        const sentences = paragraph.split('. ');
        for (const sentence of sentences) {
          if ((currentChunk + sentence).length > maxLength) {
            if (currentChunk) {
              chunks.push(currentChunk.trim());
            }
            currentChunk = sentence + '. ';
          } else {
            currentChunk += sentence + '. ';
          }
        }
      } else {
        currentChunk = paragraph + '\n\n';
      }
    } else {
      currentChunk += paragraph + '\n\n';
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

// Sleep helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Health check
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Messenger AI Bot</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          max-width: 600px;
          margin: 50px auto;
          padding: 20px;
          text-align: center;
        }
        h1 { color: #0084ff; }
        .status { color: #00c851; font-size: 24px; margin: 20px 0; }
        .info { background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <h1>🤖 Messenger AI Bot</h1>
      <div class="status">✅ Bot is Running!</div>
      <div class="info">
        <strong>Powered by:</strong><br>
        DeepSeek R1T2 Chimera via OpenRouter<br><br>
        <strong>Features:</strong><br>
        ✓ Conversation Memory<br>
        ✓ Typing Indicators<br>
        ✓ Rate Limiting<br>
        ✓ Smart Message Splitting
      </div>
    </body>
    </html>
  `);
});

// Cleanup old conversation history every hour
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [userID, timestamp] of userLastMessage.entries()) {
    if (timestamp < oneHourAgo) {
      userLastMessage.delete(userID);
      conversationHistory.delete(userID);
      console.log(`🧹 Cleaned up old data for user ${userID}`);
    }
  }
}, 60 * 60 * 1000); // Run every hour

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📅 Started at: ${new Date().toLocaleString()}`);
});

module.exports = app;