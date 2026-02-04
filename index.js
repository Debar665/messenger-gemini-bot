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
    console.log('✅ Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    console.error('❌ Webhook verification failed');
    res.sendStatus(403);
  }
});

// Receive messages
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('📥 Webhook received');
    
    if (body.object === 'page') {
      // Send 200 OK immediately to Facebook
      res.status(200).send('EVENT_RECEIVED');
      console.log('✅ Sent 200 OK to Facebook');
      
      // Process entries
      for (const entry of body.entry) {
        const pageID = entry.id;
        console.log(`📄 Processing entry for page ${pageID}`);
        
        for (const event of entry.messaging) {
          console.log(`🔍 Event type check:`, {
            hasMessage: !!event.message,
            hasText: !!event.message?.text,
            isEcho: !!event.message?.is_echo,
            hasSender: !!event.sender,
            senderID: event.sender?.id,
            pageID: pageID
          });

          // Only process user messages (not echoes, not from page)
          if (event.message && 
              event.message.text && 
              !event.message.is_echo &&
              event.sender &&
              event.sender.id !== pageID) {
            
            const senderID = event.sender.id;
            const userMessage = event.message.text;

            console.log(`📨 Processing message from user ${senderID}: "${userMessage}"`);

            // Rate limiting
            const now = Date.now();
            const lastMessageTime = userLastMessage.get(senderID) || 0;
            
            if (now - lastMessageTime < RATE_LIMIT_MS) {
              console.log(`⏱️ Rate limit hit for user ${senderID}`);
              continue;
            }
            
            userLastMessage.set(senderID, now);
            console.log(`✅ Rate limit check passed`);

            // Show typing indicator
            console.log(`⌨️ Sending typing indicator ON`);
            await sendTypingIndicator(senderID, true);

            try {
              console.log(`🤖 Calling AI API...`);
              const aiReply = await getAIResponse(senderID, userMessage);
              console.log(`✅ AI Response received:`, aiReply.substring(0, 100) + '...');
              
              // Split long messages
              console.log(`✂️ Splitting message...`);
              const messageChunks = splitMessage(aiReply, 2000);
              console.log(`📦 Message split into ${messageChunks.length} chunks`);
              
              // Send each chunk
              for (let i = 0; i < messageChunks.length; i++) {
                console.log(`📤 Sending chunk ${i + 1}/${messageChunks.length}...`);
                
                if (i > 0) {
                  await sleep(1000);
                }
                
                const result = await sendFacebookMessage(senderID, messageChunks[i]);
                console.log(`✅ Chunk ${i + 1} sent successfully:`, result);
              }
              
              console.log(`🎉 All messages sent to user ${senderID}`);

            } catch (error) {
              console.error(`❌ ERROR in message processing:`, {
                message: error.message,
                stack: error.stack
              });
              
              try {
                await sendFacebookMessage(senderID, '😔 Sorry, I encountered an error. Please try again.');
              } catch (sendError) {
                console.error(`❌ Failed to send error message:`, sendError.message);
              }
            } finally {
              console.log(`⌨️ Sending typing indicator OFF`);
              await sendTypingIndicator(senderID, false);
            }
          } else {
            console.log(`⏭️ Skipping event (echo or from page)`);
          }
        }
      }
    } else {
      console.log(`❌ Not a page object:`, body.object);
      res.sendStatus(404);
    }

  } catch (error) {
    console.error('💥 Webhook error:', error);
    res.status(500).send('ERROR');
  }
});

// Get AI response with conversation context
async function getAIResponse(userID, message) {
  console.log(`🧠 Getting AI response for user ${userID}`);
  
  // Get or create conversation history
  if (!conversationHistory.has(userID)) {
    conversationHistory.set(userID, []);
    console.log(`📝 Created new conversation history for user ${userID}`);
  }
  
  const history = conversationHistory.get(userID);
  console.log(`📚 Current history length: ${history.length}`);
  
  // Add user message
  history.push({
    role: 'user',
    content: message
  });
  
  // Keep only recent messages
  if (history.length > MAX_HISTORY * 2) {
    history.splice(0, history.length - (MAX_HISTORY * 2));
    console.log(`✂️ Trimmed history to ${history.length} messages`);
  }
  
  // Get date/time
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

  console.log(`📅 Context: ${dateStr}, ${timeStr}`);

  const systemPrompt = `You are a helpful, friendly AI assistant chatting via Facebook Messenger.

CURRENT CONTEXT:
- Date: ${dateStr}
- Time: ${timeStr} (Iraq time)

RESPONSE GUIDELINES:
- Keep responses SHORT and conversational (2-3 paragraphs max)
- Be friendly and natural
- If asked about real-time info, explain you don't have live data

Be helpful and concise!`;

  try {
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    
    console.log(`🌐 Making API request to OpenRouter...`);
    console.log(`📊 Sending ${history.length} messages in history`);
    
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
          ...history
        ],
        temperature: 0.7,
        max_tokens: 1500
      })
    });

    console.log(`📡 API Response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ API Error Response:`, errorText);
      throw new Error(`AI API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log(`📦 API Response data keys:`, Object.keys(data));
    console.log(`📦 Choices:`, data.choices?.length);
    
    if (data.choices && data.choices[0] && data.choices[0].message) {
      const aiMessage = data.choices[0].message.content;
      console.log(`✅ AI message extracted, length: ${aiMessage.length}`);
      
      // Add to history
      history.push({
        role: 'assistant',
        content: aiMessage
      });
      
      conversationHistory.set(userID, history);
      
      return aiMessage;
    }
    
    console.error(`❌ Unexpected API response structure:`, JSON.stringify(data));
    throw new Error('No response from AI');
    
  } catch (error) {
    console.error('❌ AI API error:', error);
    throw error;
  }
}

// Send typing indicator
async function sendTypingIndicator(recipientID, isTyping) {
  try {
    const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { id: recipientID },
        sender_action: isTyping ? 'typing_on' : 'typing_off'
      })
    });
    
    console.log(`⌨️ Typing indicator ${isTyping ? 'ON' : 'OFF'} - Status: ${response.status}`);
  } catch (error) {
    console.warn('⚠️ Typing indicator failed:', error.message);
  }
}

// Send message to Facebook
async function sendFacebookMessage(recipientID, messageText) {
  console.log(`📤 Sending to ${recipientID}, length: ${messageText.length} chars`);
  
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

  console.log(`📡 Facebook API response status: ${response.status}`);

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`❌ Facebook API error response:`, errorText);
    throw new Error(`Facebook API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  console.log(`✅ Facebook API success:`, result);
  return result;
}

// Split long messages
function splitMessage(text, maxLength = 2000) {
  console.log(`✂️ Splitting message of length ${text.length}, max: ${maxLength}`);
  
  if (text.length <= maxLength) {
    console.log(`✅ No split needed`);
    return [text];
  }
  
  const chunks = [];
  let currentChunk = '';
  
  const paragraphs = text.split('\n\n');
  console.log(`📄 Split into ${paragraphs.length} paragraphs`);
  
  for (const paragraph of paragraphs) {
    if ((currentChunk + paragraph).length > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      
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
  
  console.log(`✅ Split into ${chunks.length} chunks`);
  return chunks;
}

// Sleep helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Health check
app.get('/', (req, res) => {
  res.send('Bot is running with DeepSeek R1T2 Chimera + Debug Logging!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = app;