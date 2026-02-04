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
          // Only process user messages
          if (event.message && 
              event.message.text && 
              !event.message.is_echo &&
              event.sender &&
              event.sender.id !== pageID) {
            
            const senderID = event.sender.id;
            const userMessage = event.message.text;

            console.log(`Message from user ${senderID}: ${userMessage}`);

            // Process asynchronously to not block webhook
            handleUserMessage(senderID, userMessage).catch(err => {
              console.error('Message handling error:', err.message);
            });
          }
        }
      }
    }

    // Respond immediately to Facebook
    res.status(200).send('EVENT_RECEIVED');

  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).send('ERROR');
  }
});

// Handle user message with typing indicator
async function handleUserMessage(senderID, userMessage) {
  try {
    // Show typing indicator
    await sendTypingIndicator(senderID, true);

    // Get AI response
    const aiReply = await callDeepSeekAPI(userMessage);
    console.log('AI response received');

    // Turn off typing before sending
    await sendTypingIndicator(senderID, false);

    // Break long messages into chunks (max 320 chars each for mobile)
    const chunks = splitIntoChunks(aiReply, 320);
    
    // Send each chunk with natural delays
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        // Small delay between chunks + typing indicator
        await sendTypingIndicator(senderID, true);
        await sleep(1500); // 1.5 second delay
        await sendTypingIndicator(senderID, false);
      }
      
      await sendFacebookMessage(senderID, chunks[i]);
      console.log(`Sent chunk ${i + 1}/${chunks.length}`);
    }

    console.log('All messages sent successfully');

  } catch (error) {
    console.error('Error in handleUserMessage:', error.message);
    
    // Turn off typing
    await sendTypingIndicator(senderID, false);
    
    // Send friendly error message
    try {
      await sendFacebookMessage(senderID, '😔 Sorry, I had trouble with that. Could you try asking again?');
    } catch (sendError) {
      console.error('Failed to send error message:', sendError.message);
    }
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
    // Don't throw - typing indicator failure shouldn't break the bot
  }
}

// Function to call DeepSeek API with improvements
async function callDeepSeekAPI(userMessage) {
  const url = 'https://openrouter.ai/api/v1/chat/completions';

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

  const systemPrompt = `You are a helpful AI assistant chatting on Facebook Messenger. Today is ${dateStr}, ${timeStr} (Iraq time).

IMPORTANT RULES:
- Keep responses SHORT and conversational (2-3 paragraphs maximum)
- Write like you're texting a friend - natural and friendly
- Use simple language, avoid complex terms
- If asked about real-time info (sports scores, current news, stock prices), politely say you can't access live data and suggest searching online
- Break complex topics into easy-to-understand points

Be helpful, concise, and friendly!`;

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
      max_tokens: 800  // Limit response length for conciseness
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  }
  
  throw new Error('No response from DeepSeek');
}

// Split long messages into mobile-friendly chunks
function splitIntoChunks(text, maxChars = 320) {
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks = [];
  const paragraphs = text.split('\n\n');
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    // If adding this paragraph exceeds limit
    if ((currentChunk + '\n\n' + paragraph).length > maxChars) {
      // Save current chunk if it has content
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }

      // If single paragraph is too long, split by sentences
      if (paragraph.length > maxChars) {
        const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
        
        for (const sentence of sentences) {
          if ((currentChunk + ' ' + sentence).length > maxChars) {
            if (currentChunk.trim()) {
              chunks.push(currentChunk.trim());
            }
            currentChunk = sentence;
          } else {
            currentChunk += (currentChunk ? ' ' : '') + sentence;
          }
        }
      } else {
        currentChunk = paragraph;
      }
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
    }
  }

  // Add remaining chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

// Sleep helper for delays
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    throw new Error(`Facebook API error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

// Health check
app.get('/', (req, res) => {
  res.send('🤖 Bot Running | DeepSeek R1T2 Chimera | Smart & Concise Responses');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;