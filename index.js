const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json());

// Load from environment variables (SECURE!)
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'my_secret_verify_token_12345';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

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

// Receive messages
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Webhook received');

    if (body.object === 'page') {
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

            console.log(`Message from user ${senderID}: ${userMessage}`);

            // Process message asynchronously (don't block)
            processMessage(senderID, userMessage).catch(err => {
              console.error('Error in processMessage:', err.message);
            });
          }
        }
      }
    }

    // Send 200 OK immediately
    res.status(200).send('EVENT_RECEIVED');

  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).send('ERROR');
  }
});

// Process message asynchronously
async function processMessage(senderID, userMessage) {
  try {
    // Show typing indicator
    await sendTypingIndicator(senderID, true);

    // Get AI response
    const aiReply = await callDeepSeekAPI(userMessage);
    console.log('AI response received');

    // Send reply to user
    await sendFacebookMessage(senderID, aiReply);
    console.log('Message sent successfully');

  } catch (error) {
    console.error('Error processing message:', error.message);
    // Send error message to user
    try {
      await sendFacebookMessage(senderID, 'Sorry, I encountered an error. Please try again.');
    } catch (sendError) {
      console.error('Failed to send error message:', sendError.message);
    }
  } finally {
    // Turn off typing indicator
    await sendTypingIndicator(senderID, false);
  }
}

// Send typing indicator
async function sendTypingIndicator(recipientID, isTyping) {
  try {
    const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
    
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientID },
        sender_action: isTyping ? 'typing_on' : 'typing_off'
      })
    });
  } catch (error) {
    // Don't throw - typing indicator is not critical
    console.warn('Typing indicator failed:', error.message);
  }
}

// Function to call DeepSeek API with improved prompting
async function callDeepSeekAPI(userMessage) {
  const url = 'https://openrouter.ai/api/v1/chat/completions';

  // Get current date/time
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

  const systemPrompt = `You are a helpful AI assistant. Today is ${dateStr}, ${timeStr} (Iraq time).

Guidelines:
- Keep responses concise and friendly (mobile chat style)
- If asked about real-time info (sports scores, news, stock prices), politely say you don't have access to live data
- Be natural and conversational`;

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
        {
          role: 'user',
          content: userMessage
        }
      ],
      temperature: 0.7,
      max_tokens: 1500
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('DeepSeek API error:', errorText);
    throw new Error(`DeepSeek API error: ${response.status}`);
  }

  const data = await response.json();
  
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  }
  
  throw new Error('No response from DeepSeek');
}

// Function to send message to Facebook
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
    console.error('Facebook API error:', errorText);
    throw new Error(`Facebook API error: ${response.status}`);
  }

  return await response.json();
}

// Health check
app.get('/', (req, res) => {
  res.send('🤖 Bot is running with DeepSeek R1T2 Chimera!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;